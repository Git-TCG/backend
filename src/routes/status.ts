import { transaction } from "../db/pool.js";
import { conflict } from "../http/errors.js";
import { requireUser } from "../http/session.js";
import { enqueueCard, enqueueCollect, enqueueSync } from "../jobs/kinds.js";
import { serviceDay } from "../domain/time.js";
import { STARTER_SIZE } from "../domain/allocation.js";
import type { RouteModule } from "../server.js";

export const statusRoutes: RouteModule = (app, deps) => {
  const { pool } = deps;

  // 수집·분석 진행 상황.
  app.get("/api/status", async (req) => {
    const user = await requireUser(req, deps);
    const [jobs, cards, poolReady] = await Promise.all([
      pool.query(
        `SELECT j.id, j.kind, j.status, j.attempts, j.last_error, j.updated_at,
                (j.payload->>'repoId')::bigint AS repo_id
         FROM jobs j
         WHERE (j.kind IN ('collect', 'sync') AND (j.payload->>'userId')::bigint = $1)
            OR (j.kind = 'card' AND (j.payload->>'repoId')::bigint IN (SELECT repo_id FROM user_cards WHERE user_id = $1)
                AND (j.payload->>'seasonId')::int = (SELECT id FROM seasons WHERE status = 'active'))
         ORDER BY j.id DESC LIMIT 50`,
        [user.id],
      ),
      pool.query<{ owned: number; ready: number }>(
        `SELECT count(*) AS owned, count(*) FILTER (WHERE v.status = 'ready') AS ready
         FROM user_cards c
         LEFT JOIN card_versions v ON v.repo_id = c.repo_id AND v.season_id = (SELECT id FROM seasons WHERE status = 'active')
         WHERE c.user_id = $1`,
        [user.id],
      ),
      pool.query<{ count: number }>(
        `SELECT count(*) AS count FROM pool_memberships p
         JOIN card_versions v ON v.repo_id = p.repo_id AND v.status = 'ready'
           AND v.season_id = (SELECT id FROM seasons WHERE status = 'active')
         WHERE p.pool = 'general' AND p.active`,
      ),
    ]);
    const counts = cards.rows[0]!;
    return {
      consent: user.consent_at !== null,
      allocated: user.allocated_at !== null,
      owned: counts.owned,
      ready: counts.ready,
      starterMissing: user.allocated_at ? Math.max(0, STARTER_SIZE - counts.owned) : null,
      poolReady: poolReady.rows[0]!.count,
      canPlayOwned: counts.ready >= STARTER_SIZE,
      jobs: jobs.rows,
    };
  });

  // 실패하거나 멈춘 수집·분석 작업을 다시 등록한다. 이미 준비된 카드는 다시 만들지 않는다.
  app.post("/api/status/retry", async (req) => {
    const user = await requireUser(req, deps, { write: true });
    if (!user.consent_at) throw conflict("카드 이용 동의가 필요합니다");
    await transaction(pool, async (c) => {
      if (!user.allocated_at) await enqueueCollect(c, user.id, { force: true });
      const notReady = await c.query<{ repo_id: number }>(
        `SELECT c.repo_id FROM user_cards c
         LEFT JOIN card_versions v ON v.repo_id = c.repo_id AND v.season_id = (SELECT id FROM seasons WHERE status = 'active')
         WHERE c.user_id = $1 AND v.status IS DISTINCT FROM 'ready'`,
        [user.id],
      );
      for (const { repo_id } of notReady.rows) await enqueueCard(c, repo_id, undefined, { force: true });
    });
    return { ok: true };
  });

  // 신규 Repo 동기화. 하루 한 번만 새 작업이 만들어진다.
  app.post("/api/repos/sync", async (req) => {
    const user = await requireUser(req, deps, { write: true });
    if (!user.allocated_at) throw conflict("첫 수집이 끝난 뒤 동기화할 수 있습니다");
    await enqueueSync(pool, user.id, serviceDay());
    return { ok: true };
  });
};
