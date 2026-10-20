import type pg from "pg";
import { RetryLaterError } from "./errors.js";

export interface Job {
  id: number;
  kind: string;
  key: string;
  payload: unknown;
  attempts: number;
  max_attempts: number;
}

export interface JobHandler {
  run: (job: Job) => Promise<void>;
  /** 마지막 재시도까지 실패했을 때 호출한다(예: 카드 상태를 error로 기록). */
  onFinalFailure?: (job: Job, error: Error) => Promise<void>;
}

/** 실행 중 표시가 이 시간보다 오래되면 워커가 죽은 것으로 보고 다시 가져간다. */
const STALE_LOCK = "10 minutes";

export function backoffMs(attempts: number): number {
  return Math.min(30 * 60_000, 30_000 * 2 ** Math.max(0, attempts - 1));
}

/** 처리할 수 있는 종류의 작업 하나를 가져와 실행한다. 처리한 작업이 없으면 false. */
export async function runNextJob(pool: pg.Pool, handlers: Record<string, JobHandler>): Promise<boolean> {
  const kinds = Object.keys(handlers);
  const claimed = await pool.query<Job>(
    `UPDATE jobs SET status = 'running', locked_at = now(), attempts = attempts + 1, updated_at = now()
     WHERE id = (
       SELECT id FROM jobs
       WHERE kind = ANY($1::text[])
         AND ((status = 'queued' AND available_at <= now())
              OR (status = 'running' AND locked_at < now() - interval '${STALE_LOCK}'))
       -- 카드 일러스트는 오래 걸리고 급하지 않으므로 다른 작업이 없을 때만 처리한다.
       ORDER BY (kind = 'image'), available_at, id
       FOR UPDATE SKIP LOCKED
       LIMIT 1
     )
     RETURNING id, kind, key, payload, attempts, max_attempts`,
    [kinds],
  );
  const job = claimed.rows[0];
  if (!job) return false;
  const handler = handlers[job.kind]!;
  try {
    await handler.run(job);
    await pool.query("UPDATE jobs SET status = 'done', last_error = NULL, locked_at = NULL, updated_at = now() WHERE id = $1", [
      job.id,
    ]);
  } catch (raw) {
    const err = raw instanceof Error ? raw : new Error(String(raw));
    if (err instanceof RetryLaterError) {
      await pool.query(
        `UPDATE jobs SET status = 'queued', attempts = attempts - 1, locked_at = NULL, last_error = $2,
           available_at = now() + make_interval(secs => $3), updated_at = now() WHERE id = $1`,
        [job.id, err.message, err.delayMs / 1000],
      );
      return true;
    }
    const final = job.attempts >= job.max_attempts;
    await pool.query(
      `UPDATE jobs SET status = $2, locked_at = NULL, last_error = $3,
         available_at = now() + make_interval(secs => $4), updated_at = now() WHERE id = $1`,
      [job.id, final ? "error" : "queued", err.message.slice(0, 1000), backoffMs(job.attempts) / 1000],
    );
    if (final) await handler.onFinalFailure?.(job, err);
  }
  return true;
}
