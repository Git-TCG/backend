import { EFFECTS } from "./effects.js";
import { randomInt, shuffleInPlace } from "./rng.js";
import {
  LANES,
  type Action,
  type ApplyResult,
  type AttackTarget,
  type CardDef,
  type GameEvent,
  type Lane,
  type MatchState,
  type PlayerIndex,
  type PlayerState,
  type Unit,
} from "./types.js";

export const RULES = {
  version: "rules-v0.1",
  deckSize: 7,
  startingCore: 15,
  startingHand: 3,
  handLimit: 7,
  resourceCap: 5,
  reshuffleDamage: 2,
  turnLimit: 40,
} as const;

export interface CreateMatchInput {
  cards: Record<string, CardDef>;
  decks: [string[], string[]];
  seed: number;
}

class RuleError extends Error {}

interface Ctx {
  s: MatchState;
  events: GameEvent[];
}

const other = (p: PlayerIndex): PlayerIndex => (p === 0 ? 1 : 0);

function emptyPlayer(deck: string[]): PlayerState {
  return {
    core: RULES.startingCore,
    maxResource: 0,
    resource: 0,
    bonusNextTurn: 0,
    deck,
    hand: [],
    discard: [],
    field: [null, null, null],
    mulliganDone: false,
    scrappedThisTurn: false,
  };
}

export function validateDeck(cards: Record<string, CardDef>, deck: string[]): string | null {
  if (deck.length !== RULES.deckSize) return `덱은 ${RULES.deckSize}장이어야 합니다`;
  if (new Set(deck).size !== deck.length) return "덱에 같은 Repo가 중복되었습니다";
  const missing = deck.find((id) => !cards[id]);
  return missing ? `알 수 없는 카드: ${missing}` : null;
}

export function createMatch({ cards, decks, seed }: CreateMatchInput): MatchState {
  for (const deck of decks) {
    const err = validateDeck(cards, deck);
    if (err) throw new RuleError(err);
  }
  const s: MatchState = {
    rulesVersion: RULES.version,
    cards: structuredClone(cards),
    players: [emptyPlayer([...decks[0]]), emptyPlayer([...decks[1]])],
    first: 0,
    active: 0,
    turn: 0,
    phase: "mulligan",
    pending: null,
    result: null,
    rng: seed | 0,
    nextUid: 1,
    seq: 0,
  };
  for (const p of s.players) shuffleInPlace(s, p.deck);
  s.first = randomInt(s, 2) as PlayerIndex;
  s.active = s.first;
  for (const p of s.players) p.hand = p.deck.splice(0, RULES.startingHand);
  return s;
}

// ---------------------------------------------------------------------------
// 조회 헬퍼

function card(s: MatchState, id: string): CardDef {
  const c = s.cards[id];
  if (!c) throw new Error(`card not found: ${id}`);
  return c;
}

function abilityOf(s: MatchState, unit: Unit) {
  return card(s, unit.cardId).ability;
}

function hasEffect(s: MatchState, unit: Unit, effect: string): boolean {
  return abilityOf(s, unit)?.effect === effect;
}

function adjacentLanes(lane: Lane): Lane[] {
  return LANES.filter((l) => Math.abs(l - lane) === 1);
}

export function effectiveAttack(s: MatchState, player: PlayerIndex, lane: Lane): number {
  const field = s.players[player].field;
  const unit = field[lane];
  if (!unit) return 0;
  let atk = unit.attack;
  for (const l of adjacentLanes(lane)) {
    const ally = field[l];
    const ability = ally && abilityOf(s, ally);
    if (ability?.effect === "inspire") atk += ability.amount;
  }
  return atk;
}

function enemyLanes(s: MatchState, player: PlayerIndex): Lane[] {
  const field = s.players[other(player)].field;
  return LANES.filter((l) => field[l] !== null);
}

/** 기획서 6장 공격 대상 규칙: 맞은편 우선, 그다음 다른 칸, 필드가 비었을 때만 코어. */
export function legalAttackTargets(s: MatchState, player: PlayerIndex, lane: Lane): AttackTarget[] {
  const enemies = enemyLanes(s, player);
  if (enemies.includes(lane)) return [{ kind: "unit", lane }];
  if (enemies.length > 0) return enemies.map((l) => ({ kind: "unit", lane: l }));
  return [{ kind: "core" }];
}

// ---------------------------------------------------------------------------
// 상태 변경 기본 동작

function checkResult(ctx: Ctx): boolean {
  const { s } = ctx;
  if (s.result) return true;
  const dead0 = s.players[0].core <= 0;
  const dead1 = s.players[1].core <= 0;
  if (!dead0 && !dead1) return false;
  s.result =
    dead0 && dead1
      ? { kind: "draw", reason: "simultaneous" }
      : { kind: "win", winner: dead0 ? 1 : 0, reason: "core" };
  s.phase = "ended";
  s.pending = null;
  ctx.events.push({ type: "matchEnded", result: s.result });
  return true;
}

function damageCore(ctx: Ctx, player: PlayerIndex, amount: number) {
  if (amount <= 0) return;
  ctx.s.players[player].core -= amount;
  ctx.events.push({ type: "damaged", player, lane: "core", amount });
}

/** 피해량을 계산만 한다. shield를 반영한다. */
function damageTaken(s: MatchState, unit: Unit, amount: number): number {
  const ability = abilityOf(s, unit);
  const reduced = ability?.effect === "shield" ? amount - ability.amount : amount;
  return Math.max(0, reduced);
}

function damageUnit(ctx: Ctx, player: PlayerIndex, lane: Lane, amount: number) {
  const unit = ctx.s.players[player].field[lane];
  if (!unit) return;
  const dealt = damageTaken(ctx.s, unit, amount);
  if (dealt <= 0) return;
  unit.durability -= dealt;
  ctx.events.push({ type: "damaged", player, lane, amount: dealt });
}

/** 한 장 뽑기. 덱이 비면 폐기 더미를 섞어 재구성하고 코어 피해를 받는다. */
function drawOne(ctx: Ctx, player: PlayerIndex) {
  const { s } = ctx;
  const p = s.players[player];
  if (p.deck.length === 0) {
    if (p.discard.length === 0) {
      damageCore(ctx, player, RULES.reshuffleDamage);
      ctx.events.push({ type: "fatigue", player, damage: RULES.reshuffleDamage });
      checkResult(ctx);
      return;
    }
    p.deck = p.discard;
    p.discard = [];
    shuffleInPlace(s, p.deck);
    damageCore(ctx, player, RULES.reshuffleDamage);
    ctx.events.push({ type: "reshuffled", player, damage: RULES.reshuffleDamage });
    if (checkResult(ctx)) return;
  }
  const cardId = p.deck.shift()!;
  if (p.hand.length >= RULES.handLimit) {
    p.discard.push(cardId);
    ctx.events.push({ type: "burned", player, cardId });
  } else {
    p.hand.push(cardId);
    ctx.events.push({ type: "drew", player, cardId });
  }
}

function drawCards(ctx: Ctx, player: PlayerIndex, count: number) {
  for (let i = 0; i < count && !ctx.s.result; i++) drawOne(ctx, player);
}

/**
 * 내구도 0 이하 프로젝트를 동시에 제거하고, 파괴 시 능력을 현재 턴 플레이어 왼쪽부터,
 * 이후 상대 왼쪽부터 처리한다. 그 결과로 새로 파괴된 카드가 있으면 반복한다.
 */
function resolveDeaths(ctx: Ctx) {
  const { s } = ctx;
  while (!s.result) {
    const removed: { player: PlayerIndex; lane: Lane; unit: Unit }[] = [];
    for (const player of [s.active, other(s.active)]) {
      const p = s.players[player];
      for (const lane of LANES) {
        const unit = p.field[lane];
        if (unit && unit.durability <= 0) removed.push({ player, lane, unit });
      }
    }
    if (removed.length === 0) return;
    for (const { player, lane, unit } of removed) {
      s.players[player].field[lane] = null;
      s.players[player].discard.push(unit.cardId);
      ctx.events.push({ type: "destroyed", player, lane, cardId: unit.cardId });
    }
    for (const { player, lane, unit } of removed) {
      const ability = abilityOf(s, unit);
      if (!ability || EFFECTS[ability.effect].trigger !== "destroyed") continue;
      ctx.events.push({ type: "abilityTriggered", player, lane, effect: ability.effect });
      if (ability.effect === "backup") drawCards(ctx, player, ability.amount);
      if (ability.effect === "explode") damageUnit(ctx, other(player), lane, ability.amount);
      if (checkResult(ctx)) return;
    }
  }
}

function startTurn(ctx: Ctx, player: PlayerIndex) {
  const { s } = ctx;
  const p = s.players[player];
  s.active = player;
  s.turn += 1;
  s.phase = "deploy";
  p.maxResource = Math.min(RULES.resourceCap, p.maxResource + 1);
  p.resource = p.maxResource + p.bonusNextTurn;
  p.bonusNextTurn = 0;
  p.scrappedThisTurn = false;
  for (const unit of p.field) {
    if (!unit) continue;
    unit.canAttack = !unit.frozen;
    unit.frozen = false;
  }
  ctx.events.push({ type: "turnStarted", player, turn: s.turn });
  const skipDraw = s.turn === 1;
  if (!skipDraw) drawOne(ctx, player);
}

// ---------------------------------------------------------------------------
// 행동

function requireActive(s: MatchState, player: PlayerIndex) {
  if (s.phase === "mulligan") throw new RuleError("아직 시작 손패 교환 중입니다");
  if (s.active !== player) throw new RuleError("상대 턴입니다");
  if (s.pending) throw new RuleError("먼저 카드를 선택해야 합니다");
}

function doMulligan(ctx: Ctx, player: PlayerIndex, cardIds: string[]) {
  const { s } = ctx;
  if (s.phase !== "mulligan") throw new RuleError("교환 단계가 아닙니다");
  const p = s.players[player];
  if (p.mulliganDone) throw new RuleError("이미 교환했습니다");
  if (new Set(cardIds).size !== cardIds.length || cardIds.some((id) => !p.hand.includes(id))) {
    throw new RuleError("손에 없는 카드는 교환할 수 없습니다");
  }
  p.hand = p.hand.filter((id) => !cardIds.includes(id));
  p.hand.push(...p.deck.splice(0, cardIds.length));
  p.deck.push(...cardIds);
  shuffleInPlace(s, p.deck);
  p.mulliganDone = true;
  ctx.events.push({ type: "mulliganed", player, count: cardIds.length });
  if (s.players.every((pl) => pl.mulliganDone)) startTurn(ctx, s.first);
}

function doDeploy(ctx: Ctx, player: PlayerIndex, cardId: string, lane: Lane, targetLane?: Lane) {
  const { s } = ctx;
  requireActive(s, player);
  if (s.phase !== "deploy") throw new RuleError("전투 단계에서는 배포할 수 없습니다");
  const p = s.players[player];
  if (!p.hand.includes(cardId)) throw new RuleError("손에 없는 카드입니다");
  if (!LANES.includes(lane)) throw new RuleError("잘못된 칸입니다");
  if (p.field[lane]) throw new RuleError("이미 프로젝트가 있는 칸입니다");
  const def = card(s, cardId);
  if (def.cost > p.resource) throw new RuleError("자원이 부족합니다");

  const template = def.ability ? EFFECTS[def.ability.effect] : null;
  const needsTarget = template?.trigger === "deploy" && template.targetsEnemyUnit;
  const enemies = enemyLanes(s, player);
  if (needsTarget && enemies.length > 0) {
    if (targetLane === undefined || !enemies.includes(targetLane)) {
      throw new RuleError("능력 대상으로 상대 프로젝트를 지정해야 합니다");
    }
  } else if (targetLane !== undefined) {
    throw new RuleError("이 카드는 대상을 지정하지 않습니다");
  }

  p.resource -= def.cost;
  p.hand.splice(p.hand.indexOf(cardId), 1);
  const rush = def.ability?.effect === "rush";
  p.field[lane] = {
    uid: s.nextUid++,
    cardId,
    attack: def.attack,
    durability: def.durability,
    maxDurability: def.durability,
    deployedTurn: s.turn,
    canAttack: rush,
    frozen: false,
  };
  ctx.events.push({ type: "deployed", player, cardId, lane });

  const ability = def.ability;
  if (!ability || EFFECTS[ability.effect].trigger !== "deploy") return;
  ctx.events.push({ type: "abilityTriggered", player, lane, effect: ability.effect });
  const foe = other(player);
  switch (ability.effect) {
    case "strike":
      if (targetLane !== undefined) damageUnit(ctx, foe, targetLane, ability.amount);
      break;
    case "ping":
      damageCore(ctx, foe, ability.amount);
      break;
    case "draw":
      drawCards(ctx, player, ability.amount);
      break;
    case "fortify": {
      const healed = Math.min(ability.amount, RULES.startingCore - p.core);
      if (healed > 0) {
        p.core += healed;
        ctx.events.push({ type: "healed", player, lane: "core", amount: healed });
      }
      break;
    }
    case "freeze": {
      const target = targetLane !== undefined ? s.players[foe].field[targetLane] : null;
      if (target) target.frozen = true;
      break;
    }
    case "weaken": {
      const target = targetLane !== undefined ? s.players[foe].field[targetLane] : null;
      if (target) target.attack = Math.max(0, target.attack - ability.amount);
      break;
    }
    case "scout": {
      const options = p.deck.slice(0, 2);
      if (options.length === 1) {
        drawOne(ctx, player);
      } else if (options.length === 2) {
        s.pending = { kind: "scout", player, options };
        ctx.events.push({ type: "choiceRequested", player });
      }
      break;
    }
  }
  if (checkResult(ctx)) return;
  resolveDeaths(ctx);
}

function doChoose(ctx: Ctx, player: PlayerIndex, cardId: string) {
  const { s } = ctx;
  const pending = s.pending;
  if (!pending || pending.player !== player) throw new RuleError("선택할 항목이 없습니다");
  if (!pending.options.includes(cardId)) throw new RuleError("후보에 없는 카드입니다");
  const p = s.players[player];
  p.deck = p.deck.filter((id) => !pending.options.includes(id));
  p.deck.push(...pending.options.filter((id) => id !== cardId));
  s.pending = null;
  if (p.hand.length >= RULES.handLimit) {
    p.discard.push(cardId);
    ctx.events.push({ type: "burned", player, cardId });
  } else {
    p.hand.push(cardId);
    ctx.events.push({ type: "drew", player, cardId });
  }
}

function doScrap(ctx: Ctx, player: PlayerIndex, lane: Lane) {
  const { s } = ctx;
  requireActive(s, player);
  if (s.phase !== "deploy") throw new RuleError("폐기는 배포 단계에서만 할 수 있습니다");
  const p = s.players[player];
  if (p.scrappedThisTurn) throw new RuleError("폐기는 턴당 한 번입니다");
  const unit = p.field[lane];
  if (!unit) throw new RuleError("빈칸입니다");
  p.field[lane] = null;
  p.discard.push(unit.cardId);
  p.scrappedThisTurn = true;
  ctx.events.push({ type: "scrapped", player, lane });
}

function enterCombat(ctx: Ctx, player: PlayerIndex) {
  if (ctx.s.phase === "combat") return;
  ctx.s.phase = "combat";
  ctx.events.push({ type: "combatBegan", player });
}

function doAttack(ctx: Ctx, player: PlayerIndex, lane: Lane, target: AttackTarget) {
  const { s } = ctx;
  requireActive(s, player);
  const unit = s.players[player].field[lane];
  if (!unit) throw new RuleError("공격할 프로젝트가 없습니다");
  if (!unit.canAttack) {
    throw new RuleError(unit.deployedTurn === s.turn ? "배포한 턴에는 공격할 수 없습니다" : "이번 턴에 공격할 수 없습니다");
  }
  const legal = legalAttackTargets(s, player, lane);
  const ok = legal.some((t) =>
    t.kind === "core" ? target.kind === "core" : target.kind === "unit" && target.lane === t.lane,
  );
  if (!ok) throw new RuleError("공격할 수 없는 대상입니다");

  enterCombat(ctx, player);
  unit.canAttack = false;
  ctx.events.push({ type: "attacked", player, lane, target });
  const foe = other(player);
  const atk = effectiveAttack(s, player, lane);
  if (target.kind === "core") {
    damageCore(ctx, foe, atk);
    checkResult(ctx);
    return;
  }
  // 동시 반격: 피해량을 먼저 모두 계산한 뒤 적용한다.
  const counter = effectiveAttack(s, foe, target.lane);
  damageUnit(ctx, foe, target.lane, atk);
  damageUnit(ctx, player, lane, counter);
  resolveDeaths(ctx);
}

function doEndTurn(ctx: Ctx, player: PlayerIndex) {
  const { s } = ctx;
  requireActive(s, player);
  const p = s.players[player];
  const snapshot = LANES.map((lane) => p.field[lane]);
  for (const lane of LANES) {
    const unit = snapshot[lane];
    if (!unit || p.field[lane] !== unit) continue;
    const ability = abilityOf(s, unit);
    if (!ability || EFFECTS[ability.effect].trigger !== "turnEnd") continue;
    ctx.events.push({ type: "abilityTriggered", player, lane, effect: ability.effect });
    if (ability.effect === "overclock") p.bonusNextTurn = Math.max(p.bonusNextTurn, 1);
    if (ability.effect === "repair") {
      const candidates = adjacentLanes(lane)
        .map((l) => ({ l, u: p.field[l] }))
        .filter((c): c is { l: Lane; u: Unit } => !!c.u && c.u.durability < c.u.maxDurability)
        .sort((a, b) => b.u.maxDurability - b.u.durability - (a.u.maxDurability - a.u.durability) || a.l - b.l);
      const pick = candidates[0];
      if (pick) {
        const healed = Math.min(ability.amount, pick.u.maxDurability - pick.u.durability);
        pick.u.durability += healed;
        ctx.events.push({ type: "healed", player, lane: pick.l, amount: healed });
      }
    }
    resolveDeaths(ctx);
    if (s.result) return;
  }
  ctx.events.push({ type: "turnEnded", player });
  if (s.turn >= RULES.turnLimit) {
    s.result = { kind: "draw", reason: "turnLimit" };
    s.phase = "ended";
    ctx.events.push({ type: "matchEnded", result: s.result });
    return;
  }
  startTurn(ctx, other(player));
}

/** 순수 함수: 입력 상태를 바꾸지 않고 새 상태와 이벤트를 돌려준다. */
export function applyAction(state: MatchState, player: PlayerIndex, action: Action): ApplyResult {
  if (state.result) return { ok: false, error: "이미 끝난 경기입니다" };
  const ctx: Ctx = { s: structuredClone(state), events: [] };
  try {
    switch (action.type) {
      case "mulligan":
        doMulligan(ctx, player, action.cardIds);
        break;
      case "deploy":
        doDeploy(ctx, player, action.cardId, action.lane, action.targetLane);
        break;
      case "scrap":
        doScrap(ctx, player, action.lane);
        break;
      case "beginCombat":
        requireActive(ctx.s, player);
        if (ctx.s.phase === "combat") throw new RuleError("이미 전투 단계입니다");
        enterCombat(ctx, player);
        break;
      case "attack":
        doAttack(ctx, player, action.lane, action.target);
        break;
      case "choose":
        doChoose(ctx, player, action.cardId);
        break;
      case "endTurn":
        doEndTurn(ctx, player);
        break;
      case "concede":
        ctx.s.result = { kind: "win", winner: other(player), reason: "concede" };
        ctx.s.phase = "ended";
        ctx.s.pending = null;
        ctx.events.push({ type: "matchEnded", result: ctx.s.result });
        break;
      default:
        throw new RuleError("알 수 없는 행동입니다");
    }
  } catch (err) {
    if (err instanceof RuleError) return { ok: false, error: err.message };
    throw err;
  }
  ctx.s.seq += 1;
  return { ok: true, state: ctx.s, events: ctx.events };
}

/** 현재 플레이어가 할 수 있는 행동 목록(항복 제외). 봇과 퍼즈 테스트에 쓴다. */
export function legalActions(s: MatchState, player: PlayerIndex): Action[] {
  if (s.result) return [];
  const p = s.players[player];
  if (s.phase === "mulligan") {
    return p.mulliganDone ? [] : [{ type: "mulligan", cardIds: [] }, { type: "mulligan", cardIds: [...p.hand] }];
  }
  if (s.pending) {
    return s.pending.player === player ? s.pending.options.map((cardId) => ({ type: "choose", cardId })) : [];
  }
  if (s.active !== player) return [];

  const actions: Action[] = [{ type: "endTurn" }];
  if (s.phase === "deploy") {
    actions.push({ type: "beginCombat" });
    const empty = LANES.filter((l) => !p.field[l]);
    const enemies = enemyLanes(s, player);
    for (const cardId of new Set(p.hand)) {
      const def = card(s, cardId);
      if (def.cost > p.resource) continue;
      const t = def.ability ? EFFECTS[def.ability.effect] : null;
      const targeted = t?.trigger === "deploy" && t.targetsEnemyUnit && enemies.length > 0;
      for (const lane of empty) {
        if (targeted) for (const targetLane of enemies) actions.push({ type: "deploy", cardId, lane, targetLane });
        else actions.push({ type: "deploy", cardId, lane });
      }
    }
    if (!p.scrappedThisTurn) {
      for (const lane of LANES) if (p.field[lane]) actions.push({ type: "scrap", lane });
    }
  }
  for (const lane of LANES) {
    if (!p.field[lane]?.canAttack) continue;
    for (const target of legalAttackTargets(s, player, lane)) actions.push({ type: "attack", lane, target });
  }
  return actions;
}

export interface PlayerView {
  you: PlayerIndex;
  rulesVersion: string;
  turn: number;
  active: PlayerIndex;
  phase: MatchState["phase"];
  result: MatchState["result"];
  seq: number;
  pending: { kind: "scout"; options: string[] } | null;
  me: Omit<PlayerState, "deck"> & { deckCount: number };
  opponent: Omit<PlayerState, "deck" | "hand"> & { deckCount: number; handCount: number };
}

/** 상대 손패, 양쪽 덱 순서, 난수 상태를 가린 화면용 상태. */
export function viewFor(s: MatchState, player: PlayerIndex): PlayerView {
  const { deck: myDeck, ...me } = s.players[player];
  const { deck: oppDeck, hand: oppHand, ...opp } = s.players[other(player)];
  return structuredClone({
    you: player,
    rulesVersion: s.rulesVersion,
    turn: s.turn,
    active: s.active,
    phase: s.phase,
    result: s.result,
    seq: s.seq,
    pending: s.pending?.player === player ? { kind: s.pending.kind, options: s.pending.options } : null,
    me: { ...me, deckCount: myDeck.length },
    opponent: { ...opp, deckCount: oppDeck.length, handCount: oppHand.length },
  });
}
