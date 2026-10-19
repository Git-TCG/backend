import { describe, expect, it } from "vitest";
import { EFFECTS } from "../engine/effects.js";
import { RULES, validateDeck } from "../engine/engine.js";
import type { Grade } from "../engine/types.js";
import {
  COST_BY_GRADE,
  GENERIC_CLASSIFICATION,
  ROLES,
  ROLE_EFFECTS,
  SAMPLE_CARDS,
  SAMPLE_DECKS,
  abilityWeight,
  buildCardDefinition,
  chooseEffect,
  computeGrade,
  gradeForScore,
  gradeWithFallback,
  parseClassification,
  statBudget,
  type RepoMetrics,
} from "./index.js";

const metrics = (m: Partial<RepoMetrics> = {}): RepoMetrics => ({
  stars: 0,
  forks: 0,
  activeMonths: 0,
  contributors: 0,
  releaseMonths: 0,
  ...m,
});

describe("등급 공식", () => {
  it("기획서 예시: Stars 10, Forks 2, 활동 6개월, 기여자 2명, Release 2개월 → 약 36.77점 B등급", () => {
    const r = computeGrade(metrics({ stars: 10, forks: 2, activeMonths: 6, contributors: 2, releaseMonths: 2 }));
    expect(r.status).toBe("graded");
    if (r.status !== "graded") return;
    expect(r.breakdown.stars).toBeCloseTo(8.68, 2);
    expect(r.breakdown.forks).toBeCloseTo(3.57, 2);
    expect(r.breakdown.activity).toBe(15);
    expect(r.breakdown.collaboration).toBeCloseTo(4.52, 2);
    expect(r.breakdown.releases).toBe(5);
    expect(r.score).toBeCloseTo(36.77, 1);
    expect(r.grade).toBe("B");
    expect(r.displayScore).toBe("36.8");
  });

  it("모든 항목이 상한에 닿으면 100점 SS", () => {
    const r = computeGrade(
      metrics({ stars: 5000, forks: 500, activeMonths: 12, contributors: 50, releaseMonths: 12 }),
    );
    expect(r.status === "graded" && r.score).toBe(100);
    expect(r.status === "graded" && r.grade).toBe("SS");
  });

  it("상한 정확히 1000 Stars, 100 Forks, 10명, 6개월에서 만점이 된다", () => {
    const r = computeGrade(
      metrics({ stars: 1000, forks: 100, activeMonths: 12, contributors: 10, releaseMonths: 6 }),
    );
    expect(r.status === "graded" && r.score).toBeCloseTo(100, 10);
  });

  it("기여자 1명 이하는 협업 점수 0", () => {
    for (const contributors of [0, 1]) {
      const r = computeGrade(metrics({ contributors }));
      expect(r.status === "graded" && r.breakdown.collaboration).toBe(0);
    }
  });

  it.each<[number, Grade]>([
    [0, "C"],
    [19.999, "C"],
    [20, "B"],
    [39.999, "B"],
    [40, "A"],
    [59.999, "A"],
    [60, "S"],
    [79.999, "S"],
    [80, "SS"],
    [100, "SS"],
  ])("점수 %f는 %s등급", (score, grade) => {
    expect(gradeForScore(score)).toBe(grade);
  });

  it("누락된 지표는 0으로 바꾸지 않고 산정을 보류한다", () => {
    const r = computeGrade(metrics({ stars: null, releaseMonths: null }));
    expect(r).toEqual({ status: "pending", version: "grade-v0.1", missing: ["stars", "releaseMonths"] });
    expect(computeGrade(metrics()).status).toBe("graded");
  });

  it("기존 카드는 지표가 누락되면 직전 유효 등급을 유지한다", () => {
    const prev = computeGrade(metrics({ stars: 10 }));
    if (prev.status !== "graded") throw new Error("unreachable");
    expect(gradeWithFallback(metrics({ forks: null }), prev)).toEqual({ ...prev, stale: true });
    expect(gradeWithFallback(metrics({ forks: null }), null).status).toBe("pending");
  });

  it("잘못된 값은 거부한다", () => {
    expect(() => computeGrade(metrics({ stars: -1 }))).toThrow(RangeError);
    expect(() => computeGrade(metrics({ activeMonths: 13 }))).toThrow(RangeError);
    expect(() => computeGrade(metrics({ forks: 1.5 }))).toThrow(RangeError);
  });
});

describe("카드 수치 배분", () => {
  const grades = Object.keys(COST_BY_GRADE) as Grade[];

  it("모든 등급·역할·허용 효과 조합이 예산을 정확히 지키고 내구도가 1 이상이다", () => {
    for (const grade of grades) {
      for (const role of ROLES) {
        for (const effect of ROLE_EFFECTS[role]) {
          const c = buildCardDefinition({ id: "x", name: "x", grade, role, tags: [], effect });
          expect(c.cost).toBe(COST_BY_GRADE[grade]);
          expect(c.durability).toBeGreaterThanOrEqual(1);
          expect(c.attack).toBeGreaterThanOrEqual(0);
          const budget = Math.max(2 + abilityWeight(c.ability!), statBudget(c.cost));
          expect(c.attack + c.durability + abilityWeight(c.ability!)).toBe(budget);
          expect(c.cost).toBeLessThanOrEqual(RULES.resourceCap);
        }
      }
    }
  });

  it("공격 역할은 같은 조건의 방어 역할보다 공격력이 높다", () => {
    const atk = buildCardDefinition({ id: "x", name: "x", grade: "A", role: "attack", tags: [], effect: "strike" });
    const def = buildCardDefinition({ id: "x", name: "x", grade: "A", role: "defense", tags: [], effect: "fortify" });
    expect(atk.attack).toBeGreaterThan(def.attack);
  });

  it("역할에 허용되지 않은 효과는 거부한다", () => {
    expect(() =>
      buildCardDefinition({ id: "x", name: "x", grade: "C", role: "attack", tags: [], effect: "repair" }),
    ).toThrow();
  });

  it("수량이 없는 효과는 등급과 무관하게 amount 1", () => {
    const c = buildCardDefinition({ id: "x", name: "x", grade: "SS", role: "explore", tags: [], effect: "scout" });
    expect(c.ability).toEqual({ effect: "scout", amount: 1 });
    expect(EFFECTS.scout.scalable).toBe(false);
  });
});

describe("능력 매핑", () => {
  it.each([
    ["explore", ["search"], "scout"],
    ["support", ["storage"], "repair"],
    ["defense", ["security"], "shield"],
    ["support", ["automation"], "overclock"],
    ["attack", ["game"], "rush"],
  ] as const)("기획서 4장 예시: %s + %j → %s", (role, tags, effect) => {
    expect(chooseEffect("any-repo", role, tags)).toBe(effect);
  });

  it("특성이 역할과 맞지 않으면 역할 기본 목록에서 고른다", () => {
    expect(ROLE_EFFECTS.control).toContain(chooseEffect("repo", "control", ["search"]));
  });

  it("같은 Repo는 항상 같은 효과를 받는다", () => {
    const a = chooseEffect("owner/repo", "defense", []);
    for (let i = 0; i < 10; i++) expect(chooseEffect("owner/repo", "defense", [])).toBe(a);
  });
});

describe("AI 분류 검증", () => {
  it("허용된 역할·특성만 남기고 특성은 최대 2개", () => {
    const c = parseClassification({
      role: "explore",
      tags: ["search", "made-up", "data", "storage", "search"],
      evidence: ["README에 검색 기능 설명"],
      confidence: 0.9,
    });
    expect(c).toMatchObject({ role: "explore", tags: ["search", "data"], generic: false });
  });

  it.each([
    ["형식 오류", { role: "wizard", tags: [], evidence: ["x"], confidence: 0.9 }],
    ["낮은 신뢰도", { role: "attack", tags: [], evidence: ["x"], confidence: 0.2 }],
    ["근거 없음", { role: "attack", tags: [], evidence: [], confidence: 0.9 }],
    ["null", null],
  ])("%s이면 범용 분류", (_label, raw) => {
    expect(parseClassification(raw)).toEqual(GENERIC_CLASSIFICATION);
  });
});

describe("샘플 카드", () => {
  it("서로 다른 20장이고 체험 덱 두 벌이 유효하다", () => {
    expect(Object.keys(SAMPLE_CARDS)).toHaveLength(20);
    expect(new Set(Object.values(SAMPLE_CARDS).map((c) => c.name)).size).toBe(20);
    for (const deck of SAMPLE_DECKS) expect(validateDeck(SAMPLE_CARDS, deck)).toBeNull();
  });

  it("체험 덱마다 1~2비용 카드가 3장 이상이다", () => {
    for (const deck of SAMPLE_DECKS) {
      expect(deck.filter((id) => SAMPLE_CARDS[id]!.cost <= 2).length).toBeGreaterThanOrEqual(3);
    }
  });
});
