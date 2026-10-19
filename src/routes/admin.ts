import { z } from "zod";
import { fillWaitingStarters } from "../domain/allocation.js";
import { upsertRepository } from "../domain/repositories.js";
import { transaction } from "../db/pool.js";
import { badRequest, conflict, unavailable } from "../http/errors.js";
import { requireAdmin } from "../http/session.js";
import { GitHubClient } from "../github/client.js";
import { exclusionReason, fetchRepoByName, parseRepoUrl } from "../github/repos.js";
import { enqueueCard } from "../jobs/kinds.js";
import type { RouteModule } from "../server.js";

export const adminRoutes: RouteModule = (app, deps) => {
  const { pool, env } = deps;

  app.get("/api/admin/pool", async (req) => {
    await requireAdmin(req, deps);
    const r = await pool.query(
      `SELECT r.id, r.name, r.full_name, r.url, r.owner_login, p.pool, p.active, p.weight, p.source,
              v.status, v.card, v.reason, v.updated_at
       FROM pool_memberships p
       JOIN repositories r ON r.id = p.repo_id
       LEFT JOIN card_versions v ON v.repo_id = r.id
         AND v.season_id = (SELECT id FROM seasons WHERE status = 'active')
       ORDER BY r.id`,
    );
    return { pool: r.rows };
  });

  app.post("/api/admin/repositories", async (req) => {
    const user = await requireAdmin(req, deps, { write: true });
    const { url } = z.object({ url: z.string().url() }).parse(req.body);
    const parsed = parseRepoUrl(url);
    if (!parsed) throw badRequest("https://github.com/owner/repo 형식만 허용합니다");
    if (!env.GITHUB_CLASSIC_TOKEN) throw unavailable("GitHub 앱 토큰이 설정되지 않았습니다");

    const github = new GitHubClient(env.GITHUB_CLASSIC_TOKEN);
    const repo = await fetchRepoByName(github, parsed.owner, parsed.name);
    if (!repo) throw badRequest("공개 Repo를 찾을 수 없습니다");
    const reason = exclusionReason(repo);
    if (reason) throw badRequest(`등록할 수 없는 Repo입니다 (${reason})`);

    await transaction(pool, async (c) => {
      await upsertRepository(c, repo);
      await c.query(
        `INSERT INTO pool_memberships (repo_id, pool, source, added_by)
         VALUES ($1, 'general', 'admin', $2)
         ON CONFLICT DO NOTHING`,
        [repo.id, user.id],
      );
      await enqueueCard(c, repo.id);
    });
    return { id: repo.id, status: "pending" };
  });

  app.post("/api/admin/pool/:id/publish", async (req) => {
    await requireAdmin(req, deps, { write: true });
    const id = z.coerce.number().int().positive().parse((req.params as { id: string }).id);
    const r = await pool.query(
      `UPDATE pool_memberships SET active = true
       WHERE repo_id = $1 AND pool = 'general'
         AND EXISTS (
           SELECT 1 FROM card_versions
           WHERE repo_id = $1 AND status = 'ready'
             AND season_id = (SELECT id FROM seasons WHERE status = 'active')
         )
       RETURNING repo_id`,
      [id],
    );
    if (!r.rowCount) throw conflict("준비된 카드가 없습니다");
    await fillWaitingStarters(pool);
    return { ok: true };
  });

  app.post("/api/admin/season/prepare", async (req) => {
    await requireAdmin(req, deps, { write: true });
    const next = await transaction(pool, async (c) => {
      const current = await c.query<{ id: number }>("SELECT id FROM seasons WHERE status = 'active' FOR UPDATE");
      if (!current.rows[0]) throw conflict("활성 시즌이 없습니다");
      const existingPrep = await c.query<{ id: number }>("SELECT id FROM seasons WHERE status = 'preparing'");
      if (existingPrep.rows[0]) throw conflict("이미 준비 중인 시즌이 있습니다");
      const nextId = current.rows[0].id + 1;
      await c.query("INSERT INTO seasons (id, status) VALUES ($1, 'preparing')", [nextId]);
      const repos = await c.query<{ repo_id: number }>(
        `SELECT DISTINCT repo_id FROM (
           SELECT repo_id FROM user_cards
           UNION
           SELECT repo_id FROM pool_memberships WHERE active
         ) x`,
      );
      for (const { repo_id } of repos.rows) {
        await enqueueCard(c, repo_id, nextId, { regenerate: true, force: true });
      }
      return nextId;
    });
    return { season: next };
  });

  app.post("/api/admin/season", async (req) => {
    await requireAdmin(req, deps, { write: true });
    const season = await transaction(pool, async (c) => {
      const preparing = await c.query<{ id: number }>("SELECT id FROM seasons WHERE status = 'preparing' FOR UPDATE");
      if (!preparing.rows[0]) throw conflict("새 시즌을 먼저 준비하세요");
      const nextId = preparing.rows[0].id;

      const pending = await c.query<{ count: number }>(
        `SELECT count(*) AS count FROM (
           SELECT repo_id FROM user_cards
           UNION
           SELECT repo_id FROM pool_memberships WHERE active
         ) p
         LEFT JOIN card_versions v ON v.repo_id = p.repo_id AND v.season_id = $1
         WHERE v.status IS DISTINCT FROM 'ready'`,
        [nextId],
      );
      if (pending.rows[0]!.count > 0) throw conflict("새 시즌 카드가 아직 준비되지 않았습니다");

      await c.query("UPDATE seasons SET status = 'retired' WHERE status = 'active'");
      await c.query("UPDATE seasons SET status = 'active', activated_at = now() WHERE id = $1", [nextId]);
      return nextId;
    });
    return { season };
  });
};
