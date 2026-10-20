import { grownCard } from "./growth.js";
import { randomInt, randomUUID } from "node:crypto";
import type pg from "pg";
import { SAMPLE_CARDS, SAMPLE_DECKS } from "../cards/samples.js";
import { transaction, type Queryable } from "../db/pool.js";
import {
  applyAction,
  createMatch,
  legalActions,
  viewFor,
  type Action,
  type CardDef,
  type MatchState,
  type PlayerIndex,
} from "../engine/index.js";
import { badRequest, conflict, notFound } from "../http/errors.js";
import { activeSeasonId } from "../jobs/kinds.js";
import { describeAbility } from "./cards.js";
import { settleMatchRewards } from "./rewards.js";

export const TURN_MS = 45_000;
export const BOT_USER_ID = 0;

export type DeckKind = "owned" | "trial";

export interface MatchRow {
  id: string;
  mode: "pvp" | "bot";
  season_id: number;
  player0: number;
  player1: number;
  deck0: DeckKind;
  deck1: DeckKind;
  state: MatchState;
  seq: number;
  deadline: Date;
  acted0: number;
  acted1: number;
  idle0: number;
  idle1: number;
  turn_acted: boolean;
  result: unknown;
  ended_at: Date | null;
  settled_at: Date | null;
}

interface LoadedDeck {
  ids: string[];
  cards: Record<string, CardDef>;
}

/** 보유 덱 또는 체험 덱을 불러온다. 시즌 카드가 준비되지 않으면 409. */
export async function loadDeck(q: Queryable, userId: number, kind: DeckKind, seat: PlayerIndex): Promise<LoadedDeck> {
  if (kind === "trial") {
    return { ids: SAMPLE_DECKS[seat], cards: { ...SAMPLE_CARDS } };
  }
  const d = await q.query<{ repo_ids: number[] }>("SELECT repo_ids FROM decks WHERE user_id = $1", [userId]);
  const ids = (d.rows[0]?.repo_ids ?? []).map(String);
  if (ids.length !== 7 || new Set(ids).size !== 7) throw conflict("현재 덱에 서로 다른 카드 7장을 저장하세요");

  const season = await activeSeasonId(q);
  const r = await q.query<{ repo_id: number; card: CardDef; upgrade_rank: number }>(
    `SELECT uc.repo_id, uc.upgrade_rank, v.card FROM user_cards uc
     JOIN card_versions v ON v.repo_id = uc.repo_id AND v.season_id = $2 AND v.status = 'ready'
     WHERE uc.user_id = $1 AND uc.repo_id = ANY ($3::bigint[])`,
    [userId, season, ids.map(Number)],
  );
  if (r.rowCount !== 7) throw conflict("현재 시즌에 사용할 수 없는 카드가 있습니다");
  return {
    ids: ids.map((id) => `${userId}:${id}`),
    cards: Object.fromEntries(r.rows.map((row) => {
      const id = `${userId}:${row.repo_id}`;
      return [id, { ...grownCard(row.card, row.upgrade_rank), id }];
    })),
  };
}

/** 상대 손패·덱·난수를 가린 응답. 클라이언트가 필요한 카드 정의만 포함한다. */
export function publicMatchView(state: MatchState, seat: PlayerIndex, deadline: Date) {
  const view = viewFor(state, seat);
  const opponent = state.players[(1 - seat) as PlayerIndex];
  const me = state.players[seat];
  const visible = new Set<string>([
    ...me.hand,
    ...me.discard,
    ...me.field.filter(Boolean).map((u) => u!.cardId),
    ...opponent.discard,
    ...opponent.field.filter(Boolean).map((u) => u!.cardId),
    ...(view.pending?.options ?? []),
  ]);
  const cards: Record<string, CardDef & { abilityText: string }> = {};
  for (const id of visible) {
    const c = state.cards[id];
    if (c) cards[id] = { ...c, abilityText: describeAbility(c) };
  }
  return {
    deadline,
    view,
    cards,
    legal: legalActions(state, seat),
  };
}

function isMeaningfulAction(action: Action): boolean {
  return action.type === "deploy" || action.type === "attack" || action.type === "scrap";
}

/** 제한 시간이 지난 턴을 서버가 대신 처리한다(무행동 2회면 항복). */
export async function progressTimeouts(q: Queryable, row: MatchRow): Promise<MatchRow> {
  if (row.ended_at || row.state.result) return row;
  let state = row.state;
  let deadline = new Date(row.deadline).getTime();
  let idle0 = row.idle0;
  let idle1 = row.idle1;
  let changed = false;

  for (let steps = 0; steps < 4 && !state.result && deadline <= Date.now(); steps++) {
    let seat: PlayerIndex;
    let action: Action;
    if (state.phase === "mulligan") {
      seat = !state.players[0].mulliganDone ? 0 : 1;
      action = { type: "mulligan", cardIds: [] };
    } else if (state.pending) {
      seat = state.pending.player;
      action = { type: "choose", cardId: state.pending.options[0]! };
    } else {
      seat = state.active;
      if (seat === 0) idle0++;
      else idle1++;
      const idle = seat === 0 ? idle0 : idle1;
      action = idle >= 2 ? { type: "concede" } : { type: "endTurn" };
    }
    const result = applyAction(state, seat, action);
    if (!result.ok) break;
    state = result.state;
    deadline += TURN_MS;
    changed = true;
  }

  if (!changed) return row;
  await q.query(
    `UPDATE matches SET state = $2, seq = $3, deadline = $4, idle0 = $5, idle1 = $6,
       ended_at = CASE WHEN ($2::jsonb->>'result') IS NOT NULL THEN coalesce(ended_at, now()) ELSE ended_at END,
       result = CASE WHEN ($2::jsonb->'result') IS NOT NULL THEN $2::jsonb->'result' ELSE result END
     WHERE id = $1`,
    [row.id, JSON.stringify(state), state.seq, new Date(deadline), idle0, idle1],
  );
  const updated: MatchRow = {
    ...row,
    state,
    seq: state.seq,
    deadline: new Date(deadline),
    idle0,
    idle1,
    ended_at: state.result ? row.ended_at ?? new Date() : row.ended_at,
    result: state.result ?? row.result,
  };
  await settleMatchRewards(q, updated);
  return updated;
}

/** 봇 좌석이면 합법 행동 하나를 즉시 적용한다(최대 8수). */
export async function playBotTurns(q: Queryable, row: MatchRow): Promise<MatchRow> {
  if (row.mode !== "bot" || row.ended_at || row.state.result) return row;
  const botSeat: PlayerIndex = row.player0 === BOT_USER_ID ? 0 : 1;
  let state = row.state;
  let acted0 = row.acted0;
  let acted1 = row.acted1;
  let idle0 = row.idle0;
  let idle1 = row.idle1;
  let deadline = new Date(row.deadline);
  let changed = false;

  for (let i = 0; i < 8 && !state.result; i++) {
    const legal = legalActions(state, botSeat);
    let action: Action | null = null;
    if (state.phase === "mulligan" && !state.players[botSeat].mulliganDone) {
      action = { type: "mulligan", cardIds: [] };
    } else if (state.pending?.player === botSeat) {
      action = { type: "choose", cardId: state.pending.options[0]! };
    } else if (state.active === botSeat && legal.length) {
      // 배포·공격을 우선하고, 없으면 전투 시작·턴 종료.
      action =
        legal.find((a) => a.type === "deploy" || a.type === "attack") ??
        legal.find((a) => a.type === "beginCombat") ??
        legal.find((a) => a.type === "endTurn") ??
        legal[0]!;
    }
    if (!action) break;
    const result = applyAction(state, botSeat, action);
    if (!result.ok) break;
    if (isMeaningfulAction(action)) {
      if (botSeat === 0) acted0++;
      else acted1++;
    }
    if (botSeat === 0) idle0 = 0;
    else idle1 = 0;
    const turnChanged = state.active !== result.state.active || (state.phase === "mulligan" && result.state.phase !== "mulligan");
    state = result.state;
    if (turnChanged) deadline = new Date(Date.now() + TURN_MS);
    changed = true;
  }

  if (!changed) return row;
  await q.query(
    `UPDATE matches SET state = $2, seq = $3, deadline = $4, acted0 = $5, acted1 = $6, idle0 = $7, idle1 = $8,
       ended_at = CASE WHEN ($2::jsonb->>'result') IS NOT NULL THEN coalesce(ended_at, now()) ELSE ended_at END,
       result = CASE WHEN ($2::jsonb->'result') IS NOT NULL THEN $2::jsonb->'result' ELSE result END
     WHERE id = $1`,
    [row.id, JSON.stringify(state), state.seq, deadline, acted0, acted1, idle0, idle1],
  );
  const updated: MatchRow = {
    ...row,
    state,
    seq: state.seq,
    deadline,
    acted0,
    acted1,
    idle0,
    idle1,
    ended_at: state.result ? row.ended_at ?? new Date() : row.ended_at,
    result: state.result ?? row.result,
  };
  await settleMatchRewards(q, updated);
  return updated;
}

async function insertMatch(
  q: Queryable,
  opts: {
    mode: "pvp" | "bot";
    player0: number;
    player1: number;
    deck0: DeckKind;
    deck1: DeckKind;
    cards: Record<string, CardDef>;
    decks: [string[], string[]];
  },
): Promise<string> {
  const season = await activeSeasonId(q);
  const state = createMatch({ cards: opts.cards, decks: opts.decks, seed: randomInt(1, 2_147_483_647) });
  const id = randomUUID();
  await q.query(
    `INSERT INTO matches
       (id, mode, season_id, player0, player1, deck0, deck1, state, seq, deadline)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, now() + make_interval(secs => $10))`,
    [
      id,
      opts.mode,
      season,
      opts.player0,
      opts.player1,
      opts.deck0,
      opts.deck1,
      JSON.stringify(state),
      state.seq,
      TURN_MS / 1000,
    ],
  );
  return id;
}

/** 대기열에 넣거나 상대와 즉시 매칭한다. 이미 열린 경기가 있으면 그 id를 돌려준다. */
export async function enqueueOrMatch(
  pool: pg.Pool,
  userId: number,
  deck: DeckKind,
  opponent: "queue" | "bot",
): Promise<{ waiting?: true; matchId?: string }> {
  return transaction(pool, async (c) => {
    await c.query("SELECT id FROM users WHERE id = $1 FOR UPDATE", [userId]);
    const active = await c.query<{ id: string }>(
      `SELECT id FROM matches WHERE (player0 = $1 OR player1 = $1) AND ended_at IS NULL
       ORDER BY created_at DESC LIMIT 1`,
      [userId],
    );
    if (active.rows[0]) return { matchId: active.rows[0].id };

    await loadDeck(c, userId, deck, 0);

    if (opponent === "bot") {
      const mine = await loadDeck(c, userId, deck, 0);
      const bot = await loadDeck(c, BOT_USER_ID, "trial", 1);
      const matchId = await insertMatch(c, {
        mode: "bot",
        player0: userId,
        player1: BOT_USER_ID,
        deck0: deck,
        deck1: "trial",
        cards: { ...mine.cards, ...bot.cards },
        decks: [mine.ids, bot.ids],
      });
      return { matchId };
    }

    // 오래 본 적 없는 대기자는 매칭에서 뺀다.
    await c.query("DELETE FROM queue_entries WHERE seen_at < now() - interval '2 minutes'");
    const waiting = await c.query<{ user_id: number; deck_kind: DeckKind }>(
      `SELECT user_id, deck_kind FROM queue_entries WHERE user_id <> $1
       ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1`,
      [userId],
    );
    if (!waiting.rows[0]) {
      await c.query(
        `INSERT INTO queue_entries (user_id, deck_kind, seen_at) VALUES ($1, $2, now())
         ON CONFLICT (user_id) DO UPDATE SET deck_kind = EXCLUDED.deck_kind, seen_at = now()`,
        [userId, deck],
      );
      return { waiting: true };
    }

    const opp = waiting.rows[0];
    const left = await loadDeck(c, opp.user_id, opp.deck_kind, 0);
    const right = await loadDeck(c, userId, deck, 1);
    const matchId = await insertMatch(c, {
      mode: "pvp",
      player0: opp.user_id,
      player1: userId,
      deck0: opp.deck_kind,
      deck1: deck,
      cards: { ...left.cards, ...right.cards },
      decks: [left.ids, right.ids],
    });
    await c.query("DELETE FROM queue_entries WHERE user_id IN ($1, $2)", [userId, opp.user_id]);
    return { matchId };
  });
}

export async function loadMatchForUser(q: Queryable, matchId: string, userId: number): Promise<MatchRow> {
  const r = await q.query<MatchRow>(
    `SELECT id, mode, season_id, player0, player1, deck0, deck1, state, seq, deadline,
            acted0, acted1, idle0, idle1, turn_acted, result, ended_at, settled_at
     FROM matches WHERE id = $1 AND (player0 = $2 OR player1 = $2) FOR UPDATE`,
    [matchId, userId],
  );
  if (!r.rows[0]) throw notFound("경기를 찾을 수 없습니다");
  return r.rows[0];
}

export function seatOf(row: MatchRow, userId: number): PlayerIndex {
  return row.player0 === userId ? 0 : 1;
}

export function actionsEqual(a: Action, b: Action): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export async function applyPlayerAction(
  q: Queryable,
  row: MatchRow,
  userId: number,
  action: Action,
): Promise<MatchRow> {
  const seat = seatOf(row, userId);
  if (action.type !== "concede") {
    const mulliganOk =
      action.type === "mulligan" && row.state.phase === "mulligan" && Array.isArray(action.cardIds);
    if (!mulliganOk && !legalActions(row.state, seat).some((a) => actionsEqual(a, action))) {
      throw badRequest("허용되지 않은 행동입니다");
    }
  }
  const result = applyAction(row.state, seat, action);
  if (!result.ok) throw badRequest(result.error);

  let acted0 = row.acted0;
  let acted1 = row.acted1;
  let idle0 = row.idle0;
  let idle1 = row.idle1;
  if (isMeaningfulAction(action)) {
    if (seat === 0) acted0++;
    else acted1++;
  }
  if (seat === 0) idle0 = 0;
  else idle1 = 0;

  const turnChanged =
    row.state.active !== result.state.active || (row.state.phase === "mulligan" && result.state.phase !== "mulligan");
  const deadline = turnChanged ? new Date(Date.now() + TURN_MS) : row.deadline;

  await q.query(
    `UPDATE matches SET state = $2, seq = $3, deadline = $4, acted0 = $5, acted1 = $6, idle0 = $7, idle1 = $8,
       turn_acted = true,
       ended_at = CASE WHEN ($2::jsonb->>'result') IS NOT NULL THEN coalesce(ended_at, now()) ELSE ended_at END,
       result = CASE WHEN ($2::jsonb->'result') IS NOT NULL THEN $2::jsonb->'result' ELSE result END
     WHERE id = $1`,
    [row.id, JSON.stringify(result.state), result.state.seq, deadline, acted0, acted1, idle0, idle1],
  );

  const updated: MatchRow = {
    ...row,
    state: result.state,
    seq: result.state.seq,
    deadline,
    acted0,
    acted1,
    idle0,
    idle1,
    turn_acted: true,
    ended_at: result.state.result ? row.ended_at ?? new Date() : row.ended_at,
    result: result.state.result ?? row.result,
  };
  await settleMatchRewards(q, updated);
  return updated;
}
