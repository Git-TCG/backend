export type PlayerIndex = 0 | 1;
export type Lane = 0 | 1 | 2;
export const LANES: readonly Lane[] = [0, 1, 2];

export type Grade = "C" | "B" | "A" | "S" | "SS";
export type Role = "attack" | "defense" | "support" | "control" | "explore";

/** 능력 발동 종류. static은 "필드에 있는 동안"이다. */
export type Trigger = "deploy" | "turnEnd" | "static" | "destroyed";

export type EffectId =
  | "rush"
  | "strike"
  | "ping"
  | "scout"
  | "draw"
  | "repair"
  | "overclock"
  | "fortify"
  | "inspire"
  | "shield"
  | "backup"
  | "explode"
  | "freeze"
  | "weaken";

export interface Ability {
  effect: EffectId;
  /** 피해·회복량 등. 수량이 없는 효과는 1로 둔다. */
  amount: number;
}

/** 경기 시작 시 고정되는 카드 버전. */
export interface CardDef {
  id: string;
  name: string;
  grade: Grade;
  role: Role;
  cost: number;
  attack: number;
  durability: number;
  ability: Ability | null;
}

export interface Unit {
  uid: number;
  cardId: string;
  attack: number;
  durability: number;
  maxDurability: number;
  deployedTurn: number;
  canAttack: boolean;
  frozen: boolean;
}

export interface PlayerState {
  core: number;
  maxResource: number;
  resource: number;
  /** overclock으로 예약된 다음 턴 추가 자원. */
  bonusNextTurn: number;
  /** 덱 맨 앞(0번)이 맨 위 카드이다. */
  deck: string[];
  hand: string[];
  discard: string[];
  field: [Unit | null, Unit | null, Unit | null];
  mulliganDone: boolean;
  scrappedThisTurn: boolean;
}

export type Phase = "mulligan" | "deploy" | "combat" | "ended";

export interface PendingChoice {
  kind: "scout";
  player: PlayerIndex;
  options: string[];
}

export type MatchResult =
  | { kind: "win"; winner: PlayerIndex; reason: "core" | "concede" }
  | { kind: "draw"; reason: "simultaneous" | "turnLimit" };

export interface MatchState {
  rulesVersion: string;
  cards: Record<string, CardDef>;
  players: [PlayerState, PlayerState];
  /** 선공 플레이어. */
  first: PlayerIndex;
  active: PlayerIndex;
  /** 양측 합산 턴 번호. 첫 턴이 1이다. */
  turn: number;
  phase: Phase;
  pending: PendingChoice | null;
  result: MatchResult | null;
  rng: number;
  nextUid: number;
  /** 지금까지 처리한 행동 수. 클라이언트 명령 순서 검증에 쓴다. */
  seq: number;
}

export type AttackTarget = { kind: "unit"; lane: Lane } | { kind: "core" };

export type Action =
  | { type: "mulligan"; cardIds: string[] }
  | { type: "deploy"; cardId: string; lane: Lane; targetLane?: Lane }
  | { type: "scrap"; lane: Lane }
  | { type: "beginCombat" }
  | { type: "attack"; lane: Lane; target: AttackTarget }
  | { type: "choose"; cardId: string }
  | { type: "endTurn" }
  | { type: "concede" };

export type GameEvent =
  | { type: "turnStarted"; player: PlayerIndex; turn: number }
  | { type: "drew"; player: PlayerIndex; cardId: string }
  | { type: "burned"; player: PlayerIndex; cardId: string }
  | { type: "reshuffled"; player: PlayerIndex; damage: number }
  | { type: "fatigue"; player: PlayerIndex; damage: number }
  | { type: "mulliganed"; player: PlayerIndex; count: number }
  | { type: "deployed"; player: PlayerIndex; cardId: string; lane: Lane }
  | { type: "scrapped"; player: PlayerIndex; lane: Lane }
  | { type: "combatBegan"; player: PlayerIndex }
  | { type: "attacked"; player: PlayerIndex; lane: Lane; target: AttackTarget }
  | { type: "damaged"; player: PlayerIndex; lane: Lane | "core"; amount: number }
  | { type: "healed"; player: PlayerIndex; lane: Lane | "core"; amount: number }
  | { type: "destroyed"; player: PlayerIndex; lane: Lane; cardId: string }
  | { type: "abilityTriggered"; player: PlayerIndex; lane: Lane; effect: EffectId }
  | { type: "choiceRequested"; player: PlayerIndex }
  | { type: "turnEnded"; player: PlayerIndex }
  | { type: "matchEnded"; result: MatchResult };

export type ApplyResult =
  | { ok: true; state: MatchState; events: GameEvent[] }
  | { ok: false; error: string };
