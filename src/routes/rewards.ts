import { z } from "zod";
import { drawPoolCards } from "../domain/pool.js";
import { transaction } from "../db/pool.js";
import { badRequest, conflict, notFound } from "../http/errors.js";
import { requireUser } from "../http/session.js";
import { enqueueCard } from "../jobs/kinds.js";
import type { RouteModule } from "../server.js";

const DISCOVERY_COST = 3;

export const rewardRoutes: RouteModule = (app, deps) => {
  const { pool } = deps;

  app.get("/api/discovery", async (req) => {
    const user = await requireUser(req, deps);
    const r = await pool.query<{ id: number; options: number[] }>(
      "SELECT id, options FROM discoveries WHERE user_id = $1 AND chosen IS NULL",
      [user.id],
    );
    return { tokens: user.tokens, cosmetics: user.cosmetics, open: r.rows[0] ?? null };
  });

  app.post("/api/discovery", async (req) => {
    const user = await requireUser(req, deps, { write: true });
    return transaction(pool, async (c) => {
      const locked = await c.query<{ tokens: number; cosmetics: number }>(
        "SELECT tokens, cosmetics FROM users WHERE id = $1 FOR UPDATE",
        [user.id],
      );
      const pending = await c.query<{ id: number; options: number[] }>(
        "SELECT id, options FROM discoveries WHERE user_id = $1 AND chosen IS NULL",
        [user.id],
      );
      if (pending.rows[0]) return { open: pending.rows[0], tokens: locked.rows[0]!.tokens };

      if (locked.rows[0]!.tokens < DISCOVERY_COST) throw conflict(`발견 토큰 ${DISCOVERY_COST}개가 필요합니다`);

      const personal = await c.query<{ repo_id: number }>(
        `SELECT a.repo_id FROM allocations a
         WHERE a.user_id = $1 AND a.bucket = 'personal'
           AND NOT EXISTS (SELECT 1 FROM user_cards u WHERE u.user_id = $1 AND u.repo_id = a.repo_id)
         ORDER BY a.position LIMIT 3`,
        [user.id],
      );
      const candidates = personal.rows.map((r) => r.repo_id);
      const need = 3 - candidates.length;
      if (need > 0) {
        const drawn = await drawPoolCards(c, user.id, need, candidates);
        candidates.push(...drawn);
      }

      await c.query("UPDATE users SET tokens = tokens - $2 WHERE id = $1", [user.id, DISCOVERY_COST]);

      if (!candidates.length) {
        await c.query("UPDATE users SET cosmetics = cosmetics + 1 WHERE id = $1", [user.id]);
        const after = await c.query<{ tokens: number; cosmetics: number }>(
          "SELECT tokens, cosmetics FROM users WHERE id = $1",
          [user.id],
        );
        return { open: null, cosmetic: true, tokens: after.rows[0]!.tokens, cosmetics: after.rows[0]!.cosmetics };
      }

      const inserted = await c.query<{ id: number; options: number[] }>(
        "INSERT INTO discoveries (user_id, options) VALUES ($1, $2::bigint[]) RETURNING id, options",
        [user.id, candidates],
      );
      return { open: inserted.rows[0], tokens: locked.rows[0]!.tokens - DISCOVERY_COST };
    });
  });

  app.post("/api/discovery/:id/choose", async (req) => {
    const user = await requireUser(req, deps, { write: true });
    const id = z.coerce.number().int().positive().parse((req.params as { id: string }).id);
    const { repoId } = z.object({ repoId: z.coerce.number().int().positive() }).parse(req.body);
    return transaction(pool, async (c) => {
      await c.query("SELECT id FROM users WHERE id = $1 FOR UPDATE", [user.id]);
      const r = await c.query<{ id: number; options: number[]; chosen: number | null }>(
        "SELECT id, options, chosen FROM discoveries WHERE id = $1 AND user_id = $2 FOR UPDATE",
        [id, user.id],
      );
      if (!r.rows[0]) throw notFound("발견을 찾을 수 없습니다");
      if (r.rows[0].chosen !== null) return { repoId: r.rows[0].chosen };
      if (!r.rows[0].options.includes(repoId)) throw badRequest("후보에 없는 카드입니다");
      await c.query("UPDATE discoveries SET chosen = $2, chosen_at = now() WHERE id = $1", [id, repoId]);
      await c.query(
        "INSERT INTO user_cards (user_id, repo_id, source) VALUES ($1, $2, 'discovery') ON CONFLICT DO NOTHING",
        [user.id, repoId],
      );
      await enqueueCard(c, repoId);
      return { repoId };
    });
  });
};
