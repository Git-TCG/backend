import { describe, expect, it } from "vitest";
import { SAMPLE_CARDS, SAMPLE_DECKS } from "../cards/samples.js";
import {
  RULES,
  applyAction,
  createMatch,
  legalActions,
  viewFor,
  type Ability,
  type Action,
  type CardDef,
  type Lane,
  type MatchState,
  type PlayerIndex,
} from "./index.js";

// ---------------------------------------------------------------------------
// 테스트 도구

function def(id: string, attack: number, durability: number, cost = 1, ability: Ability | null = null): CardDef {
  return { id, name: id, grade: "C", role: "attack", cost, attack, durability, ability };
}

const FILLER = Array.from({ length: 14 }, (_, i) => def(`f${i}`, 1, 1));

/** 교환을 끝내고 플레이어 0의 턴이 시작된 상태에서, 필드·손·덱을 비운다. */
function arena(extra: CardDef[]): MatchState {
  const cards = Object.fromEntries([...FILLER, ...extra].map((c) => [c.id, c]));
  let s = createMatch({
    cards,
    decks: [FILLER.slice(0, 7).map((c) => c.id), FILLER.slice(7).map((c) => c.id)],
    seed: 1,
  });
  s = must(applyAction(s, 0, { type: "mulligan", cardIds: [] })).state;
  s = must(applyAction(s, 1, { type: "mulligan", cardIds: [] })).state;
  s.active = 0;
  s.turn = 5;
  s.phase = "deploy";
  for (const p of s.players) {
    p.hand = [];
    p.deck = [];
    p.discard = [];
    p.maxResource = 5;
    p.resource = 5;
  }
  return s;
}

function place(s: MatchState, player: PlayerIndex, lane: Lane, cardId: string, opts: { fresh?: boolean } = {}) {
  const c = s.cards[cardId]!;
  s.players[player].field[lane] = {
    uid: s.nextUid++,
    cardId,
    attack: c.attack,
    durability: c.durability,
    maxDurability: c.durability,
    deployedTurn: opts.fresh ? s.turn : s.turn - 2,
    canAttack: !opts.fresh,
    frozen: false,
  };
}

function must(r: ReturnType<typeof applyAction>) {
  if (!r.ok) throw new Error(`unexpected rule error: ${r.error}`);
  return r;
}

function act(s: MatchState, player: PlayerIndex, action: Action): MatchState {
  return must(applyAction(s, player, action)).state;
}

function rejects(s: MatchState, player: PlayerIndex, action: Action): string {
  const r = applyAction(s, player, action);
  if (r.ok) throw new Error("expected rule error");
  return r.error;
}

// ---------------------------------------------------------------------------

describe("경기 준비", () => {
  it("덱은 서로 다른 Repo 7장이어야 한다", () => {
    const cards = Object.fromEntries(FILLER.map((c) => [c.id, c]));
    const seven = FILLER.slice(0, 7).map((c) => c.id);
    expect(() => createMatch({ cards, decks: [seven.slice(0, 6), seven], seed: 1 })).toThrow("7장");
    expect(() => createMatch({ cards, decks: [[...seven.slice(0, 6), "f0"], seven], seed: 1 })).toThrow("중복");
  });

  it("시작 손패 3장, 교환 후에도 3장이고 선공은 첫 턴에 뽑지 않는다", () => {
    let s = createMatch({ cards: SAMPLE_CARDS, decks: SAMPLE_DECKS, seed: 42 });
    expect(s.players.map((p) => p.hand.length)).toEqual([3, 3]);
    const first = s.first;
    const second = first === 0 ? 1 : 0;
    const swapped = s.players[first].hand.slice(0, 2);
    s = act(s, first, { type: "mulligan", cardIds: swapped });
    expect(s.phase).toBe("mulligan");
    expect(rejects(s, first, { type: "mulligan", cardIds: [] })).toContain("이미");
    s = act(s, second, { type: "mulligan", cardIds: [] });
    expect(s.phase).toBe("deploy");
    expect(s.active).toBe(first);
    expect(s.players[first].hand).toHaveLength(3);
    expect(s.players[first].resource).toBe(1);

    s = act(s, first, { type: "endTurn" });
    expect(s.active).toBe(second);
    expect(s.players[second].hand).toHaveLength(4);
  });

  it("같은 시드는 같은 경기를 만든다", () => {
    const a = createMatch({ cards: SAMPLE_CARDS, decks: SAMPLE_DECKS, seed: 7 });
    const b = createMatch({ cards: SAMPLE_CARDS, decks: SAMPLE_DECKS, seed: 7 });
    expect(a).toEqual(b);
  });
});

describe("자원", () => {
  it("매 턴 최대치 +1, 상한 5, 이월하지 않는다", () => {
    let s = arena([]);
    for (const p of s.players) p.maxResource = 0;
    const seen: number[] = [];
    for (let i = 0; i < 7; i++) {
      s = act(s, s.active, { type: "endTurn" });
      if (s.active === 1) seen.push(s.players[1].resource);
    }
    expect(seen).toEqual([1, 2, 3, 4]);
    for (let i = 0; i < 4; i++) s = act(s, s.active, { type: "endTurn" });
    expect(s.players[1].resource).toBe(5);
  });

  it("overclock은 다음 턴에 자원 1을 더하고 중첩되지 않는다", () => {
    const oc = def("oc", 1, 1, 1, { effect: "overclock", amount: 1 });
    const oc2 = def("oc2", 1, 1, 1, { effect: "overclock", amount: 1 });
    let s = arena([oc, oc2]);
    place(s, 0, 0, "oc");
    place(s, 0, 1, "oc2");
    s = act(s, 0, { type: "endTurn" });
    s = act(s, 1, { type: "endTurn" });
    expect(s.players[0].resource).toBe(6);
  });
});

describe("배포", () => {
  it("비용만큼 자원을 쓰고 빈칸에만 배치한다", () => {
    const big = def("big", 3, 3, 4);
    let s = arena([big]);
    s.players[0].hand = ["big", "f0"];
    s.players[0].resource = 3;
    expect(rejects(s, 0, { type: "deploy", cardId: "big", lane: 0 })).toContain("자원");
    s.players[0].resource = 5;
    s = act(s, 0, { type: "deploy", cardId: "big", lane: 0 });
    expect(s.players[0].resource).toBe(1);
    expect(rejects(s, 0, { type: "deploy", cardId: "f0", lane: 0 })).toContain("이미");
  });

  it("전투 단계에 들어가면 다시 배포할 수 없다", () => {
    let s = arena([]);
    s.players[0].hand = ["f0"];
    s = act(s, 0, { type: "beginCombat" });
    expect(rejects(s, 0, { type: "deploy", cardId: "f0", lane: 0 })).toContain("전투");
  });

  it("배포한 턴에는 공격할 수 없고, rush만 예외이다", () => {
    const rush = def("rush", 2, 1, 1, { effect: "rush", amount: 1 });
    let s = arena([rush]);
    s.players[0].hand = ["f0", "rush"];
    s = act(s, 0, { type: "deploy", cardId: "f0", lane: 0 });
    s = act(s, 0, { type: "deploy", cardId: "rush", lane: 1 });
    expect(rejects(s, 0, { type: "attack", lane: 0, target: { kind: "core" } })).toContain("배포한 턴");
    s = act(s, 0, { type: "attack", lane: 1, target: { kind: "core" } });
    expect(s.players[1].core).toBe(13);
  });

  it("대상 지정 능력은 적이 있으면 대상을 요구하고, 없으면 거부한다", () => {
    const striker = def("striker", 1, 1, 1, { effect: "strike", amount: 2 });
    let s = arena([striker]);
    s.players[0].hand = ["striker"];
    const noEnemy = s;
    expect(rejects(noEnemy, 0, { type: "deploy", cardId: "striker", lane: 0, targetLane: 1 })).toContain("대상");
    place(s, 1, 2, "f7");
    expect(rejects(s, 0, { type: "deploy", cardId: "striker", lane: 0 })).toContain("대상");
    s = act(s, 0, { type: "deploy", cardId: "striker", lane: 0, targetLane: 2 });
    expect(s.players[1].field[2]).toBeNull();
    expect(s.players[1].discard).toContain("f7");
  });
});

describe("공격 대상", () => {
  it("맞은편 적이 있으면 그 카드만 공격한다", () => {
    const s = arena([]);
    place(s, 0, 0, "f0");
    place(s, 1, 0, "f7");
    place(s, 1, 1, "f8");
    expect(rejects(s, 0, { type: "attack", lane: 0, target: { kind: "unit", lane: 1 } })).toContain("대상");
    expect(rejects(s, 0, { type: "attack", lane: 0, target: { kind: "core" } })).toContain("대상");
    expect(applyAction(s, 0, { type: "attack", lane: 0, target: { kind: "unit", lane: 0 } }).ok).toBe(true);
  });

  it("맞은편이 비면 다른 칸의 적 중에서 고르고, 필드가 비었을 때만 코어를 친다", () => {
    let s = arena([]);
    place(s, 0, 0, "f0");
    place(s, 0, 1, "f1");
    place(s, 1, 2, "f7");
    expect(rejects(s, 0, { type: "attack", lane: 0, target: { kind: "core" } })).toContain("대상");
    s = act(s, 0, { type: "attack", lane: 0, target: { kind: "unit", lane: 2 } });
    expect(s.players[1].field[2]).toBeNull();
    s = act(s, 0, { type: "attack", lane: 1, target: { kind: "core" } });
    expect(s.players[1].core).toBe(14);
  });

  it("프로젝트는 턴당 한 번 공격한다", () => {
    let s = arena([]);
    place(s, 0, 0, "f0");
    s = act(s, 0, { type: "attack", lane: 0, target: { kind: "core" } });
    expect(rejects(s, 0, { type: "attack", lane: 0, target: { kind: "core" } })).toContain("공격할 수 없습니다");
  });
});

describe("피해와 파괴", () => {
  it("프로젝트끼리 동시에 반격하고 함께 파괴된다", () => {
    const a = def("a", 2, 2);
    const b = def("b", 2, 2);
    let s = arena([a, b]);
    place(s, 0, 0, "a");
    place(s, 1, 0, "b");
    s = act(s, 0, { type: "attack", lane: 0, target: { kind: "unit", lane: 0 } });
    expect(s.players[0].field[0]).toBeNull();
    expect(s.players[1].field[0]).toBeNull();
    expect(s.players[0].discard).toEqual(["a"]);
    expect(s.players[1].discard).toEqual(["b"]);
  });

  it("코어는 반격하지 않는다", () => {
    let s = arena([]);
    place(s, 0, 0, "f0");
    s = act(s, 0, { type: "attack", lane: 0, target: { kind: "core" } });
    expect(s.players[0].field[0]?.durability).toBe(1);
  });

  it("피해는 턴이 지나도 유지된다", () => {
    const tank = def("tank", 1, 5);
    let s = arena([tank]);
    place(s, 0, 0, "f0");
    place(s, 1, 0, "tank");
    s = act(s, 0, { type: "attack", lane: 0, target: { kind: "unit", lane: 0 } });
    s = act(s, 0, { type: "endTurn" });
    s = act(s, 1, { type: "endTurn" });
    expect(s.players[1].field[0]?.durability).toBe(4);
  });

  it("자발적 폐기는 파괴 시 능력을 발동하지 않고, 파괴는 발동한다", () => {
    const backup = def("backup", 1, 1, 1, { effect: "backup", amount: 1 });
    let s = arena([backup]);
    s.players[0].deck = ["f1", "f2"];
    place(s, 0, 0, "backup");
    const scrapped = act(s, 0, { type: "scrap", lane: 0 });
    expect(scrapped.players[0].hand).toEqual([]);
    expect(scrapped.players[0].discard).toEqual(["backup"]);

    place(s, 1, 0, "f7");
    s = act(s, 0, { type: "attack", lane: 0, target: { kind: "unit", lane: 0 } });
    expect(s.players[0].hand).toEqual(["f1"]);
  });

  it("폐기는 턴당 한 번이다", () => {
    let s = arena([]);
    place(s, 0, 0, "f0");
    place(s, 0, 1, "f1");
    s = act(s, 0, { type: "scrap", lane: 0 });
    expect(rejects(s, 0, { type: "scrap", lane: 1 })).toContain("한 번");
  });

  it("파괴 시 능력은 현재 턴 플레이어 왼쪽부터, 이후 상대 왼쪽부터 처리한다", () => {
    const boom = (id: string) => def(id, 1, 1, 1, { effect: "explode", amount: 1 });
    const cards = [boom("m0"), boom("m1"), boom("e0"), boom("e1")];
    let s = arena(cards);
    place(s, 0, 0, "m0");
    place(s, 0, 1, "m1");
    place(s, 1, 0, "e0");
    place(s, 1, 1, "e1");
    // m0과 e0이 맞부딪혀 동시에 파괴된다.
    const r = must(applyAction(s, 0, { type: "attack", lane: 0, target: { kind: "unit", lane: 0 } }));
    const order = r.events
      .filter((e) => e.type === "abilityTriggered")
      .map((e) => (e.type === "abilityTriggered" ? `${e.player}:${e.lane}` : ""));
    expect(order).toEqual(["0:0", "1:0"]);
    s = r.state;
    // 맞은편이 이미 비어 있으므로 explode는 아무것도 맞히지 않는다.
    expect(s.players[0].field[1]?.durability).toBe(1);
    expect(s.players[1].field[1]?.durability).toBe(1);
  });

  it("explode는 맞은편 적에게 피해를 주고 연쇄 파괴를 처리한다", () => {
    const boom = def("boom", 0, 1, 1, { effect: "explode", amount: 3 });
    const sniper = def("sniper", 1, 1, 1, { effect: "strike", amount: 1 });
    let s = arena([boom, sniper]);
    place(s, 1, 2, "boom");
    place(s, 0, 2, "f0");
    s.players[0].hand = ["sniper"];
    s = act(s, 0, { type: "deploy", cardId: "sniper", lane: 0, targetLane: 2 });
    expect(s.players[1].field[2]).toBeNull();
    expect(s.players[0].field[2]).toBeNull();
  });
});

describe("정적 능력", () => {
  it("shield는 받는 피해를 줄인다", () => {
    const wall = def("wall", 0, 2, 1, { effect: "shield", amount: 1 });
    const hitter = def("hitter", 2, 3);
    let s = arena([wall, hitter]);
    place(s, 0, 0, "hitter");
    place(s, 1, 0, "wall");
    s = act(s, 0, { type: "attack", lane: 0, target: { kind: "unit", lane: 0 } });
    expect(s.players[1].field[0]?.durability).toBe(1);
  });

  it("inspire는 인접 아군의 공격력을 올린다", () => {
    const banner = def("banner", 0, 2, 1, { effect: "inspire", amount: 1 });
    let s = arena([banner]);
    place(s, 0, 0, "f0");
    place(s, 0, 1, "banner");
    s = act(s, 0, { type: "attack", lane: 0, target: { kind: "core" } });
    expect(s.players[1].core).toBe(13);
  });
});

describe("제어와 탐색", () => {
  it("freeze된 프로젝트는 다음 자기 턴에 공격하지 못하고, 그다음 턴에는 회복한다", () => {
    const ice = def("ice", 1, 1, 1, { effect: "freeze", amount: 1 });
    let s = arena([ice]);
    s.players[1].deck = ["f8", "f9", "f10"];
    place(s, 1, 0, "f7");
    s.players[0].hand = ["ice"];
    s = act(s, 0, { type: "deploy", cardId: "ice", lane: 2, targetLane: 0 });
    s = act(s, 0, { type: "endTurn" });
    expect(rejects(s, 1, { type: "attack", lane: 0, target: { kind: "unit", lane: 0 } })).toContain("공격할 수 없습니다");
    s = act(s, 1, { type: "endTurn" });
    s = act(s, 0, { type: "endTurn" });
    expect(s.players[1].field[0]?.canAttack).toBe(true);
  });

  it("weaken은 공격력을 영구히 낮추고 0 미만이 되지 않는다", () => {
    const sap = def("sap", 1, 1, 1, { effect: "weaken", amount: 2 });
    let s = arena([sap]);
    place(s, 1, 0, "f7");
    s.players[0].hand = ["sap"];
    s = act(s, 0, { type: "deploy", cardId: "sap", lane: 1, targetLane: 0 });
    expect(s.players[1].field[0]?.attack).toBe(0);
  });

  it("scout는 덱 위 2장 중 1장을 고르게 하고, 고르기 전에는 다른 행동을 막는다", () => {
    const scout = def("scout", 1, 1, 1, { effect: "scout", amount: 1 });
    let s = arena([scout]);
    s.players[0].hand = ["scout"];
    s.players[0].deck = ["f1", "f2", "f3"];
    s = act(s, 0, { type: "deploy", cardId: "scout", lane: 0 });
    expect(s.pending?.options).toEqual(["f1", "f2"]);
    expect(rejects(s, 0, { type: "endTurn" })).toContain("선택");
    expect(viewFor(s, 1).pending).toBeNull();
    expect(rejects(s, 0, { type: "choose", cardId: "f3" })).toContain("후보");
    s = act(s, 0, { type: "choose", cardId: "f2" });
    expect(s.players[0].hand).toEqual(["f2"]);
    expect(s.players[0].deck).toEqual(["f3", "f1"]);
  });

  it("repair는 인접 아군 중 가장 많이 손상된 하나를 최대 내구도까지만 회복한다", () => {
    const medic = def("medic", 0, 2, 1, { effect: "repair", amount: 2 });
    const tank = def("tank", 1, 5);
    let s = arena([medic, tank]);
    place(s, 0, 1, "medic");
    place(s, 0, 0, "tank");
    place(s, 0, 2, "f0");
    s.players[0].field[0]!.durability = 4;
    s.players[1].deck = ["f8"];
    s = act(s, 0, { type: "endTurn" });
    expect(s.players[0].field[0]?.durability).toBe(5);
  });

  it("fortify는 코어를 시작 내구도까지만 회복한다", () => {
    const heal = def("heal", 1, 1, 1, { effect: "fortify", amount: 3 });
    let s = arena([heal]);
    s.players[0].core = 14;
    s.players[0].hand = ["heal"];
    s = act(s, 0, { type: "deploy", cardId: "heal", lane: 0 });
    expect(s.players[0].core).toBe(15);
  });
});

describe("드로우와 덱 재구성", () => {
  it("덱이 비면 폐기 더미를 섞어 덱을 만들고 코어 2 피해 후 계속 뽑는다", () => {
    let s = arena([]);
    s.players[1].discard = ["f8", "f9"];
    s = act(s, 0, { type: "endTurn" });
    expect(s.players[1].core).toBe(13);
    expect(s.players[1].hand).toHaveLength(1);
    expect(s.players[1].deck).toHaveLength(1);
    expect(s.players[1].discard).toEqual([]);
  });

  it("폐기 더미도 비었으면 2 피해를 받고 드로우를 건너뛴다", () => {
    let s = arena([]);
    s = act(s, 0, { type: "endTurn" });
    expect(s.players[1].core).toBe(13);
    expect(s.players[1].hand).toHaveLength(0);
  });

  it("여러 장 드로우는 한 장씩 처리한다", () => {
    const dig = def("dig", 1, 1, 1, { effect: "draw", amount: 3 });
    let s = arena([dig]);
    s.players[0].hand = ["dig"];
    s.players[0].deck = ["f1"];
    s.players[0].discard = ["f2"];
    s = act(s, 0, { type: "deploy", cardId: "dig", lane: 0 });
    // f1 → (재구성 2 피해) f2 → (덱·폐기 모두 빔: 2 피해, 건너뜀)
    expect(s.players[0].hand.sort()).toEqual(["f1", "f2"]);
    expect(s.players[0].core).toBe(11);
  });

  it("손패 상한 7장을 넘으면 뽑은 카드는 폐기 더미로 간다", () => {
    let s = arena([]);
    s.players[1].hand = ["f7", "f8", "f9", "f10", "f11", "f12", "f13"];
    s.players[1].deck = ["f0"];
    s = act(s, 0, { type: "endTurn" });
    expect(s.players[1].hand).toHaveLength(7);
    expect(s.players[1].discard).toEqual(["f0"]);
  });
});

describe("승패", () => {
  it("상대 코어를 0 이하로 만들면 이기고, 이후 행동은 거부된다", () => {
    let s = arena([]);
    s.players[1].core = 1;
    place(s, 0, 0, "f0");
    s = act(s, 0, { type: "attack", lane: 0, target: { kind: "core" } });
    expect(s.result).toEqual({ kind: "win", winner: 0, reason: "core" });
    expect(applyAction(s, 0, { type: "endTurn" }).ok).toBe(false);
  });

  it("재구성 피해로 자기 코어가 0이 되면 진다", () => {
    let s = arena([]);
    s.players[1].core = 2;
    s.players[1].discard = ["f8"];
    s = act(s, 0, { type: "endTurn" });
    expect(s.result).toEqual({ kind: "win", winner: 0, reason: "core" });
  });

  it("총 40턴이 끝나면 무승부이다", () => {
    let s = arena([]);
    s.turn = RULES.turnLimit;
    s = act(s, 0, { type: "endTurn" });
    expect(s.result).toEqual({ kind: "draw", reason: "turnLimit" });
  });

  it("항복하면 상대가 이긴다", () => {
    const s = act(arena([]), 1, { type: "concede" });
    expect(s.result).toEqual({ kind: "win", winner: 0, reason: "concede" });
  });
});

describe("기획서 7장 턴 예시", () => {
  const drone = def("drone", 2, 2);
  const robot = def("robot", 3, 3);
  const firewall = def("firewall", 1, 2);
  const archive = def("archive", 0, 3, 2, { effect: "repair", amount: 1 });

  function setup() {
    const s = arena([drone, robot, firewall, archive]);
    s.players[0].resource = 4;
    s.players[0].hand = ["archive"];
    s.players[1].deck = ["f8"];
    place(s, 0, 0, "drone");
    place(s, 0, 1, "robot");
    place(s, 1, 0, "firewall");
    return s;
  }

  it("드론이 방화벽을 먼저 치면 로봇이 코어에 3 피해를 준다", () => {
    let s = setup();
    s = act(s, 0, { type: "deploy", cardId: "archive", lane: 2 });
    expect(rejects(s, 0, { type: "attack", lane: 2, target: { kind: "core" } })).toContain("배포한 턴");
    s = act(s, 0, { type: "attack", lane: 0, target: { kind: "unit", lane: 0 } });
    expect(s.players[1].field[0]).toBeNull();
    expect(s.players[0].field[0]?.durability).toBe(1);
    s = act(s, 0, { type: "attack", lane: 1, target: { kind: "core" } });
    expect(s.players[1].core).toBe(12);
    s = act(s, 0, { type: "endTurn" });
    // 보관소의 인접 아군은 로봇뿐이고 최대 내구도라 회복하지 않는다. 드론은 인접하지 않는다.
    expect(s.players[0].field[0]?.durability).toBe(1);
    expect(s.players[0].field[1]?.durability).toBe(3);
  });

  it("로봇부터 공격하면 방화벽을 쳐야 하므로 코어 피해가 줄어든다", () => {
    const s = setup();
    expect(rejects(s, 0, { type: "attack", lane: 1, target: { kind: "core" } })).toContain("대상");
  });
});

describe("순수성과 정보 보호", () => {
  it("applyAction은 입력 상태를 바꾸지 않는다", () => {
    const s = arena([]);
    place(s, 0, 0, "f0");
    const before = structuredClone(s);
    act(s, 0, { type: "attack", lane: 0, target: { kind: "core" } });
    expect(s).toEqual(before);
  });

  it("실패한 행동은 seq를 올리지 않는다", () => {
    const s = arena([]);
    expect(applyAction(s, 1, { type: "endTurn" }).ok).toBe(false);
    expect(act(s, 0, { type: "endTurn" }).seq).toBe(s.seq + 1);
  });

  it("viewFor는 상대 손패와 덱 순서, 난수 상태를 숨긴다", () => {
    const s = createMatch({ cards: SAMPLE_CARDS, decks: SAMPLE_DECKS, seed: 3 });
    const v = viewFor(s, 0);
    const json = JSON.stringify(v);
    expect(v.opponent.handCount).toBe(3);
    expect("hand" in v.opponent).toBe(false);
    expect("deck" in v.me).toBe(false);
    expect(json).not.toContain('"rng"');
    for (const id of s.players[1].hand) expect(v.me.hand).not.toContain(id);
  });
});

describe("무작위 플레이 퍼즈", () => {
  function countCards(s: MatchState, p: PlayerIndex) {
    const pl = s.players[p];
    return pl.deck.length + pl.hand.length + pl.discard.length + pl.field.filter(Boolean).length;
  }

  it("합법 행동만으로 진행하면 항상 끝나고, 카드 수와 상한이 유지된다", () => {
    for (let seed = 1; seed <= 300; seed++) {
      let s = createMatch({ cards: SAMPLE_CARDS, decks: SAMPLE_DECKS, seed });
      let pick = seed;
      for (let step = 0; step < 5000 && !s.result; step++) {
        const actor: PlayerIndex =
          s.phase === "mulligan" ? (s.players[0].mulliganDone ? 1 : 0) : (s.pending?.player ?? s.active);
        const options = legalActions(s, actor);
        expect(options.length).toBeGreaterThan(0);
        pick = (Math.imul(pick, 1103515245) + 12345) >>> 0;
        s = must(applyAction(s, actor, options[pick % options.length]!)).state;
        for (const p of [0, 1] as const) {
          expect(countCards(s, p)).toBe(RULES.deckSize);
          expect(s.players[p].hand.length).toBeLessThanOrEqual(RULES.handLimit);
          expect(s.players[p].maxResource).toBeLessThanOrEqual(RULES.resourceCap);
        }
      }
      expect(s.result, `seed ${seed}`).not.toBeNull();
      expect(s.turn).toBeLessThanOrEqual(RULES.turnLimit);
    }
  });
});
