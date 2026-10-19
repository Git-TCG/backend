import type { Grade } from "../engine/types.js";

export const GRADE_FORMULA_VERSION = "grade-v0.1";

/**
 * 기획서 5장 지표. null은 "수집하지 못함"이며 0과 다르다.
 * - stars, forks: 기준일 값
 * - activeMonths: 직전 완료된 12개월 중 기본 브랜치 커밋이 있었던 월 수
 * - contributors: 같은 기간 기본 브랜치의 식별 가능한 비봇 기여자 수
 * - releaseMonths: 같은 기간 정식 Release가 게시된 서로 다른 월 수
 */
export interface RepoMetrics {
  stars: number | null;
  forks: number | null;
  activeMonths: number | null;
  contributors: number | null;
  releaseMonths: number | null;
}

export interface GradeBreakdown {
  stars: number;
  forks: number;
  activity: number;
  collaboration: number;
  releases: number;
}

export type GradeResult =
  | {
      status: "graded";
      version: string;
      score: number;
      displayScore: string;
      grade: Grade;
      breakdown: GradeBreakdown;
    }
  | { status: "pending"; version: string; missing: (keyof RepoMetrics)[] };

/** 하한 이상인 가장 높은 구간. SS는 80 이상 100 이하. */
export const GRADE_THRESHOLDS: readonly [Grade, number][] = [
  ["SS", 80],
  ["S", 60],
  ["A", 40],
  ["B", 20],
  ["C", 0],
];

export function gradeForScore(score: number): Grade {
  return GRADE_THRESHOLDS.find(([, min]) => score >= min)![0];
}

const logRatio = (value: number, cap: number) => Math.min(1, Math.log(value) / Math.log(cap));

function assertCount(name: string, value: number, max = Infinity) {
  if (!Number.isInteger(value) || value < 0 || value > max) {
    throw new RangeError(`${name}은(는) 0 이상 ${max === Infinity ? "" : `${max} 이하 `}정수여야 합니다: ${value}`);
  }
}

export function computeGrade(m: RepoMetrics): GradeResult {
  const missing = (Object.keys(m) as (keyof RepoMetrics)[]).filter((k) => m[k] === null || m[k] === undefined);
  if (missing.length > 0) return { status: "pending", version: GRADE_FORMULA_VERSION, missing };

  const stars = m.stars!;
  const forks = m.forks!;
  const activeMonths = m.activeMonths!;
  const contributors = m.contributors!;
  const releaseMonths = m.releaseMonths!;
  assertCount("stars", stars);
  assertCount("forks", forks);
  assertCount("activeMonths", activeMonths, 12);
  assertCount("contributors", contributors);
  assertCount("releaseMonths", releaseMonths, 12);

  const breakdown: GradeBreakdown = {
    stars: 25 * logRatio(1 + stars, 1001),
    forks: 15 * logRatio(1 + forks, 101),
    activity: (30 * activeMonths) / 12,
    collaboration: 15 * logRatio(Math.max(1, contributors), 10),
    releases: 15 * Math.min(1, releaseMonths / 6),
  };
  const score = Object.values(breakdown).reduce((a, b) => a + b, 0);
  return {
    status: "graded",
    version: GRADE_FORMULA_VERSION,
    score,
    displayScore: score.toFixed(1),
    grade: gradeForScore(score),
    breakdown,
  };
}

/** 새 지표가 비어 있으면 기존 카드의 직전 유효 등급을 유지한다. 새 카드는 보류된다. */
export function gradeWithFallback(
  current: RepoMetrics,
  previous: Extract<GradeResult, { status: "graded" }> | null,
): GradeResult & { stale?: boolean } {
  const result = computeGrade(current);
  if (result.status === "pending" && previous) return { ...previous, stale: true };
  return result;
}
