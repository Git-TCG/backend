import type { Queryable } from "../db/pool.js";

export const UPTIME_SLOT_MINUTES = 5;
export const UPTIME_WINDOW_DAYS = 30;

function bucketStart(at: Date): Date {
  const ms = UPTIME_SLOT_MINUTES * 60_000;
  return new Date(Math.floor(at.getTime() / ms) * ms);
}

export function formatUptime(percent: number | null): string {
  if (percent === null) return "측정 중";
  return `${percent.toFixed(1)}%`;
}

export async function recordProbe(q: Queryable, at = new Date()): Promise<Date> {
  const bucket = bucketStart(at);
  await q.query(
    `INSERT INTO uptime_probes (checked_at, ok) VALUES ($1, true)
     ON CONFLICT (checked_at) DO NOTHING`,
    [bucket],
  );
  await q.query("DELETE FROM uptime_probes WHERE checked_at < now() - interval '40 days'");
  return bucket;
}

export async function uptimeSummary(q: Queryable, now = new Date()) {
  const windowStart = new Date(now.getTime() - UPTIME_WINDOW_DAYS * 86_400_000);
  const r = await q.query<{ first: Date | null; ok: number }>(
    `SELECT min(checked_at) AS first,
            count(*) FILTER (WHERE ok AND checked_at >= $1 AND checked_at <= $2) AS ok
     FROM uptime_probes`,
    [windowStart, now],
  );
  const first = r.rows[0]?.first ?? null;
  const samples = r.rows[0]?.ok ?? 0;
  if (!first || samples === 0) {
    return { windowDays: UPTIME_WINDOW_DAYS, percent: null as number | null, samples: 0 };
  }
  const start = first.getTime() < windowStart.getTime() ? windowStart : first;
  const elapsed = Math.max(0, now.getTime() - start.getTime());
  const expected = Math.max(1, Math.floor(elapsed / (UPTIME_SLOT_MINUTES * 60_000)) + 1);
  const percent = Math.max(0, Math.min(100, (samples / expected) * 100));
  return { windowDays: UPTIME_WINDOW_DAYS, percent, samples };
}
