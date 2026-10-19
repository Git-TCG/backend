import type { Queryable } from "../db/pool.js";
import { enqueue, type EnqueueOptions } from "./queue.js";

/** 작업 종류와 페이로드. 키 규칙을 한곳에 모아 중복 등록을 막는다. */
export interface JobPayloads {
  /** 최초 Repo 수집과 배정. */
  collect: { userId: number };
  /** 신규 Repo 동기화(하루 1회). */
  sync: { userId: number };
  /**
   * Repo 하나의 카드 버전 생성. 활성 시즌에 이미 준비된 카드는 force일 때만 다시 만든다.
   * aiRetry는 AI 분류 실패 뒤 다시 시도하는 횟수이다.
   */
  card: { repoId: number; seasonId: number; force?: boolean; aiRetry?: number };
  /** Repo 이름·설명·접근 상태 갱신(하루 1회). */
  refresh: { repoId: number };
}
export type JobKind = keyof JobPayloads;

export async function activeSeasonId(q: Queryable): Promise<number> {
  const r = await q.query<{ id: number }>("SELECT id FROM seasons WHERE status = 'active'");
  if (!r.rows[0]) throw new Error("활성 시즌이 없습니다");
  return r.rows[0].id;
}

export const enqueueCollect = (q: Queryable, userId: number, options?: EnqueueOptions) =>
  enqueue(q, "collect", `collect:${userId}`, { userId } satisfies JobPayloads["collect"], options);

export const enqueueSync = (q: Queryable, userId: number, day: string) =>
  enqueue(q, "sync", `sync:${userId}:${day}`, { userId } satisfies JobPayloads["sync"]);

export async function enqueueCard(
  q: Queryable,
  repoId: number,
  seasonId?: number,
  options?: EnqueueOptions & { regenerate?: boolean },
) {
  const season = seasonId ?? (await activeSeasonId(q));
  const payload: JobPayloads["card"] = { repoId, seasonId: season, ...(options?.regenerate ? { force: true } : {}) };
  await enqueue(q, "card", `card:${repoId}:${season}`, payload, options);
}

/** AI 분류가 실패해 범용 타입을 준 카드를 나중에 다시 분석한다(최대 3회). */
export async function enqueueCardAiRetry(q: Queryable, repoId: number, seasonId: number, attempt: number) {
  const payload: JobPayloads["card"] = { repoId, seasonId, force: true, aiRetry: attempt };
  await enqueue(q, "card", `card:${repoId}:${seasonId}:ai${attempt}`, payload, {
    availableAt: new Date(Date.now() + attempt * 60 * 60_000),
  });
}

export const enqueueRefresh = (q: Queryable, repoId: number, day: string, options?: EnqueueOptions) =>
  enqueue(q, "refresh", `refresh:${repoId}:${day}`, { repoId } satisfies JobPayloads["refresh"], options);
