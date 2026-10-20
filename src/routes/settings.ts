import { z } from "zod";
import { featuredCards } from "../domain/featured.js";
import { badRequest } from "../http/errors.js";
import { requireUser } from "../http/session.js";
import type { RouteModule } from "../server.js";

const bodySchema = z.object({
  badgeCardIds: z.array(z.number().int().positive()).max(3).nullable(),
});

export const settingsRoutes: RouteModule = (app, deps) => {
  const { pool } = deps;

  app.get("/api/settings", async (req) => {
    const user = await requireUser(req, deps);
    const r = await pool.query<{ badge_card_ids: number[] | null }>(
      "SELECT badge_card_ids FROM users WHERE id = $1",
      [user.id],
    );
    const badgeCardIds = r.rows[0]?.badge_card_ids ?? null;
    const preview = await featuredCards(pool, user.id, badgeCardIds);
    return { badgeCardIds, previewIds: preview.map((c) => c.id) };
  });

  app.put("/api/settings", async (req) => {
    const user = await requireUser(req, deps, { write: true });
    const { badgeCardIds } = bodySchema.parse(req.body);
    if (!badgeCardIds || badgeCardIds.length === 0) {
      await pool.query("UPDATE users SET badge_card_ids = NULL WHERE id = $1", [user.id]);
      const preview = await featuredCards(pool, user.id, null);
      return { ok: true, badgeCardIds: null, previewIds: preview.map((c) => c.id) };
    }
    if (new Set(badgeCardIds).size !== badgeCardIds.length) throw badRequest("같은 카드를 두 번 고를 수 없습니다");
    const owned = await pool.query<{ repo_id: number }>(
      `SELECT uc.repo_id FROM user_cards uc
       JOIN card_versions v ON v.repo_id = uc.repo_id AND v.status = 'ready'
         AND v.season_id = (SELECT id FROM seasons WHERE status = 'active') AND v.card IS NOT NULL
       WHERE uc.user_id = $1 AND uc.repo_id = ANY($2::bigint[])`,
      [user.id, badgeCardIds],
    );
    if (owned.rowCount !== badgeCardIds.length) throw badRequest("보유한 사용 가능 카드만 고를 수 있습니다");
    await pool.query("UPDATE users SET badge_card_ids = $2 WHERE id = $1", [user.id, badgeCardIds]);
    const preview = await featuredCards(pool, user.id, badgeCardIds);
    return { ok: true, badgeCardIds, previewIds: preview.map((c) => c.id) };
  });
};
