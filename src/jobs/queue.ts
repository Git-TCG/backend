import type { Queryable } from "../db/pool.js";

export interface EnqueueOptions {
  /** 이미 끝난(done/error) 같은 작업도 다시 대기열에 올린다. 실행 중인 작업은 건드리지 않는다. */
  force?: boolean;
  availableAt?: Date;
  maxAttempts?: number;
}

/**
 * 작업을 등록한다. key가 같은 작업은 하나만 존재한다.
 * 이미 있으면 실패(error) 상태이거나 force일 때만 다시 대기열에 올린다.
 */
export async function enqueue(
  q: Queryable,
  kind: string,
  key: string,
  payload: unknown,
  options: EnqueueOptions = {},
): Promise<void> {
  await q.query(
    `INSERT INTO jobs (kind, key, payload, available_at, max_attempts)
     VALUES ($1, $2, $3, coalesce($4, now()), $5)
     ON CONFLICT (key) DO UPDATE SET
       status = 'queued',
       attempts = 0,
       last_error = NULL,
       payload = EXCLUDED.payload,
       available_at = EXCLUDED.available_at,
       updated_at = now()
     WHERE jobs.status = 'error' OR ($6 AND jobs.status <> 'running')`,
    [kind, key, JSON.stringify(payload), options.availableAt ?? null, options.maxAttempts ?? 5, options.force ?? false],
  );
}
