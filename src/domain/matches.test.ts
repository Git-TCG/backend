import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, it } from "vitest";
import { SAMPLE_CARDS, SAMPLE_DECKS } from "../cards/samples.js";
import { createMatch } from "../engine/index.js";
import { createUser } from "../test/app.js";
import { createTestDatabase, describeDb, type TestDatabase } from "../test/db.js";
import { enqueueOrMatch, loadMatchForUser, playBotTurns, progressTimeouts, seatOf } from "./matches.js";
import { settleMatchRewards } from "./rewards.js";

describeDb("대전·대기열", () => {
  let db: TestDatabase;
  beforeAll(async () => {
    db = await createTestDatabase();
  });
  afterAll(async () => db?.drop());

  it("연습 상대와 즉시 매칭되고 봇이 멀리건을 처리한다", async () => {
    const userId = 9001;
    await createUser(db.pool, userId, { consent: true, allocated: true });
    const r = await enqueueOrMatch(db.pool, userId, "trial", "bot");
    expect(r.matchId).toBeTruthy();

    const { transaction } = await import("../db/pool.js");
    await transaction(db.pool, async (c) => {
      let row = await loadMatchForUser(c, r.matchId!, userId);
      expect(row.mode).toBe("bot");
      expect(row.player1).toBe(0);
      row = await playBotTurns(c, row);
      // 플레이어가 아직 멀리건 전이면 봇만 멀리건을 끝냈을 수 있다.
      const seat = seatOf(row, userId);
      expect(seat).toBe(0);
      expect(row.state.players[1].mulliganDone || row.state.phase !== "mulligan").toBeTruthy();
    });
  });

  it("제한 시간이 지나면 턴을 대신 종료한다", async () => {
    const userId = 9002;
    await createUser(db.pool, userId, { consent: true, allocated: true });
    const state = createMatch({ cards: SAMPLE_CARDS, decks: SAMPLE_DECKS, seed: 42 });
    // 멀리건을 건너뛰고 배포 단계로 맞춘다.
    state.players[0].mulliganDone = true;
    state.players[1].mulliganDone = true;
    state.phase = "deploy";
    state.turn = 1;
    state.active = 0;
    state.seq = 2;
    const id = randomUUID();
    await db.pool.query(
      `INSERT INTO matches (id, mode, season_id, player0, player1, deck0, deck1, state, seq, deadline)
       VALUES ($1, 'bot', 1, $2, 0, 'trial', 'trial', $3, $4, now() - interval '1 second')`,
      [id, userId, JSON.stringify(state), state.seq],
    );

    const { transaction } = await import("../db/pool.js");
    await transaction(db.pool, async (c) => {
      let row = await loadMatchForUser(c, id, userId);
      row = await progressTimeouts(c, row);
      expect(row.state.seq).toBeGreaterThan(state.seq);
      expect(new Date(row.deadline).getTime()).toBeGreaterThan(Date.now() - 1000);
    });
  });

  it("연습 대전은 실제로 플레이해서 4턴 이상 진행했을 때만 튜토리얼 보상을 한 번 준다", async () => {
    const played = 9010;
    const idle = 9011;
    for (const id of [played, idle]) await createUser(db.pool, id, { consent: true, allocated: true });
    const state = createMatch({ cards: SAMPLE_CARDS, decks: SAMPLE_DECKS, seed: 7 });
    const insert = async (userId: number, acted: number, turn: number) => {
      const id = randomUUID();
      const ended = { ...state, turn, phase: "ended", result: { kind: "win", winner: 1, reason: "concede" } };
      await db.pool.query(
        `INSERT INTO matches (id, mode, season_id, player0, player1, deck0, deck1, state, seq, deadline, acted0)
         VALUES ($1, 'bot', 1, $2, 0, 'trial', 'trial', $3, 0, now(), $4)`,
        [id, userId, JSON.stringify(ended), acted],
      );
      return { id, player0: userId, player1: 0, acted0: acted, acted1: 0, settled_at: null, state: ended };
    };
    const grants = async (userId: number) =>
      (await db.pool.query("SELECT grant_key FROM reward_grants WHERE user_id = $1", [userId])).rows.map((r) => r.grant_key);

    await settleMatchRewards(db.pool, await insert(idle, 0, 10));
    await settleMatchRewards(db.pool, await insert(idle, 3, 2));
    expect(await grants(idle)).toEqual([]);

    await settleMatchRewards(db.pool, await insert(played, 2, 6));
    await settleMatchRewards(db.pool, await insert(played, 2, 6));
    expect(await grants(played)).toEqual(["tutorial"]);
    const user = await db.pool.query("SELECT normal_matches FROM users WHERE id = $1", [played]);
    expect(user.rows[0].normal_matches).toBe(0);
  });
});
