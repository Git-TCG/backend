import type pg from "pg";
import { CLASSIFIER_VERSION, classifyRepository, type ClassificationResult } from "../ai/classify.js";
import { buildCardDefinition, CARD_RULES_VERSION } from "../cards/build.js";
import { computeGrade, GRADE_FORMULA_VERSION } from "../cards/grade.js";
import type { Classification } from "../cards/taxonomy.js";
import type { Env } from "../config/env.js";
import type { Queryable } from "../db/pool.js";
import { EFFECTS } from "../engine/effects.js";
import type { CardDef } from "../engine/types.js";
import type { GitHubClient } from "../github/client.js";
import { classificationInputHash, loadClassificationInput } from "../github/content.js";
import { collectMetrics, CONTRIBUTOR_RULE } from "../github/metrics.js";
import { fetchRepoById, type GithubRepo } from "../github/repos.js";
import { enqueueCardAiRetry } from "../jobs/kinds.js";
import { recordRepoMissing, upsertRepository } from "./repositories.js";

export const MAX_AI_RETRIES = 3;
export const RULES_VERSION = [CARD_RULES_VERSION, GRADE_FORMULA_VERSION, CLASSIFIER_VERSION].join("+");

/** card_versions.classification에 저장하는 값. */
export interface StoredClassification extends Classification {
  cardName: string | null;
  concept: string | null;
  model: string | null;
  aiFailed: boolean;
  error?: string;
}

export type CardOutcome =
  | { status: "ready"; card: CardDef; reused: "none" | "classification" | "previous"; aiFailed: boolean }
  | { status: "pending" | "error"; reason: string }
  | { status: "skipped"; reason: string };

interface VersionRow {
  season_id: number;
  status: string;
  card: CardDef | null;
  grade: unknown;
  classification: StoredClassification | null;
  input_hash: string | null;
}

export interface CardPipelineDeps {
  pool: pg.Pool;
  env: Pick<Env, "OPENAI_API_KEY" | "OPENAI_MODEL">;
  github: GitHubClient;
}

async function writeVersion(
  q: Queryable,
  repoId: number,
  seasonId: number,
  fields: {
    status: "ready" | "pending" | "error";
    card?: CardDef | null;
    grade?: unknown;
    classification?: StoredClassification | null;
    inputHash?: string | null;
    reason?: string | null;
  },
) {
  await q.query(
    `INSERT INTO card_versions (repo_id, season_id, status, card, grade, classification, input_hash, rules_version, reason)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (repo_id, season_id) DO UPDATE SET
       status = EXCLUDED.status, card = EXCLUDED.card, grade = EXCLUDED.grade,
       classification = EXCLUDED.classification, input_hash = EXCLUDED.input_hash,
       rules_version = EXCLUDED.rules_version, reason = EXCLUDED.reason, updated_at = now()`,
    [
      repoId,
      seasonId,
      fields.status,
      fields.card ? JSON.stringify(fields.card) : null,
      fields.grade === undefined ? null : JSON.stringify(fields.grade),
      fields.classification ? JSON.stringify(fields.classification) : null,
      fields.inputHash ?? null,
      RULES_VERSION,
      fields.reason ?? null,
    ],
  );
}

/** 이 시즌보다 이전(같은 시즌 포함)에 준비된 가장 최근 버전. */
async function latestReady(q: Queryable, repoId: number, seasonId: number): Promise<VersionRow | null> {
  const r = await q.query<VersionRow>(
    `SELECT season_id, status, card, grade, classification, input_hash FROM card_versions
     WHERE repo_id = $1 AND season_id <= $2 AND status = 'ready'
     ORDER BY season_id DESC LIMIT 1`,
    [repoId, seasonId],
  );
  return r.rows[0] ?? null;
}

/** 직전 유효 카드를 이 시즌 버전으로 유지한다. 없으면 status로 기록한다. */
async function keepPreviousOr(
  q: Queryable,
  repoId: number,
  seasonId: number,
  reason: string,
  status: "pending" | "error",
): Promise<CardOutcome> {
  const previous = await latestReady(q, repoId, seasonId);
  if (previous?.card) {
    if (previous.season_id !== seasonId) {
      await writeVersion(q, repoId, seasonId, {
        status: "ready",
        card: previous.card,
        grade: previous.grade,
        classification: previous.classification,
        inputHash: previous.input_hash,
        reason: `${reason}: 직전 유효 카드 유지`,
      });
    }
    return { status: "ready", card: previous.card, reused: "previous", aiFailed: false };
  }
  await writeVersion(q, repoId, seasonId, { status, reason });
  return { status, reason };
}

function cardSource(repo: GithubRepo): NonNullable<CardDef["source"]> {
  return { repoId: repo.id, fullName: repo.full_name, url: repo.html_url, owner: repo.owner.login };
}

/**
 * 4장 생성 파이프라인: 메타데이터 수집 → 규칙 기반 등급 → 제한된 입력 → AI 분류 → 서버 능력 매핑 → 수치 검증 → 발행.
 * 활성 시즌에서 이미 준비된 카드는 force가 아니면 바꾸지 않는다(같은 시즌 동일 카드 원칙).
 */
export async function generateCardVersion(
  deps: CardPipelineDeps,
  job: { repoId: number; seasonId: number; force?: boolean; aiRetry?: number },
): Promise<CardOutcome> {
  const { pool, github } = deps;
  const { repoId, seasonId } = job;

  const season = await pool.query<{ status: string }>("SELECT status FROM seasons WHERE id = $1", [seasonId]);
  if (!season.rows[0] || season.rows[0].status === "retired") return { status: "skipped", reason: "지난 시즌" };
  const existing = await pool.query<VersionRow>(
    "SELECT season_id, status, card, grade, classification, input_hash FROM card_versions WHERE repo_id = $1 AND season_id = $2",
    [repoId, seasonId],
  );
  const current = existing.rows[0];
  if (current?.status === "ready" && !job.force) return { status: "skipped", reason: "이미 준비된 카드" };

  const stored = await pool.query<{ hidden_at: Date | null }>("SELECT hidden_at FROM repositories WHERE id = $1", [repoId]);
  if (!stored.rows[0]) return { status: "skipped", reason: "등록되지 않은 Repo" };
  if (stored.rows[0].hidden_at) return keepPreviousOr(pool, repoId, seasonId, "운영자가 숨긴 Repo", "error");

  const repo = await fetchRepoById(github, repoId);
  if (!repo) {
    await recordRepoMissing(pool, repoId);
    return keepPreviousOr(pool, repoId, seasonId, "공개 Repo에 접근할 수 없습니다", "error");
  }
  await upsertRepository(pool, repo);

  const metrics = await collectMetrics(github, repo);
  const grade = computeGrade(metrics);
  if (grade.status === "pending") {
    return keepPreviousOr(pool, repoId, seasonId, `등급 지표 누락(${grade.missing.join(", ")})`, "pending");
  }

  const input = await loadClassificationInput(github, repo);
  const inputHash = classificationInputHash(input);
  const sameInput = await pool.query<{ classification: StoredClassification }>(
    `SELECT classification FROM card_versions
     WHERE repo_id = $1 AND input_hash = $2 AND status = 'ready' AND classification IS NOT NULL
       AND classification->>'model' IS NOT NULL
       AND NOT coalesce((classification->>'aiFailed')::boolean, false)
     ORDER BY season_id DESC LIMIT 1`,
    [repoId, inputHash],
  );

  let classification: StoredClassification;
  let reused: "none" | "classification" = "none";
  if (sameInput.rows[0]) {
    // 입력이 바뀌지 않았으면 AI를 다시 부르지 않는다(9장).
    classification = sameInput.rows[0].classification;
    reused = "classification";
  } else {
    const result: ClassificationResult = await classifyRepository(deps.env, input);
    classification = {
      ...result.classification,
      cardName: result.cardName,
      concept: result.concept,
      model: result.model,
      aiFailed: result.failed,
      ...(result.error ? { error: result.error } : {}),
    };
  }

  const card: CardDef = {
    ...buildCardDefinition({
      id: String(repoId),
      name: classification.cardName ?? repo.name,
      grade: grade.grade,
      role: classification.role,
      tags: classification.tags,
    }),
    source: cardSource(repo),
    ...(classification.concept ? { concept: classification.concept } : {}),
  };

  const reason = classification.aiFailed
    ? `AI 분석 실패로 임시 범용 타입 적용: ${classification.error ?? ""}`.trim()
    : classification.generic
      ? (classification.error ?? "정보가 부족해 범용 분류 적용")
      : null;
  await writeVersion(pool, repoId, seasonId, {
    status: "ready",
    card,
    grade: { ...grade, metrics: { ...metrics, contributorRule: CONTRIBUTOR_RULE } },
    classification,
    inputHash,
    reason,
  });

  const attempt = (job.aiRetry ?? 0) + 1;
  if (classification.aiFailed && attempt <= MAX_AI_RETRIES) await enqueueCardAiRetry(pool, repoId, seasonId, attempt);
  return { status: "ready", card, reused, aiFailed: classification.aiFailed };
}

/** 마지막 재시도까지 실패한 카드 작업. 준비된 버전이 없을 때만 error로 기록한다. */
export async function recordCardFailure(q: Queryable, repoId: number, seasonId: number, message: string) {
  await q.query(
    `INSERT INTO card_versions (repo_id, season_id, status, reason, rules_version) VALUES ($1, $2, 'error', $3, $4)
     ON CONFLICT (repo_id, season_id) DO UPDATE SET status = 'error', reason = EXCLUDED.reason, updated_at = now()
     WHERE card_versions.status <> 'ready'`,
    [repoId, seasonId, `카드 생성 실패: ${message}`.slice(0, 500), RULES_VERSION],
  );
}

/** 화면에 보여 줄 능력 설명. */
export function describeAbility(card: Pick<CardDef, "ability">): string {
  if (!card.ability) return "능력 없음";
  return EFFECTS[card.ability.effect].describe(card.ability.amount);
}
