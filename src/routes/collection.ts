import { z } from "zod";
import { SAMPLE_CARDS, SAMPLE_DECKS } from "../cards/samples.js";
import { describeAbility } from "../domain/cards.js";
import { transaction } from "../db/pool.js";
import { badRequest, notFound } from "../http/errors.js";
import { requireUser } from "../http/session.js";
import { activeSeasonId } from "../jobs/kinds.js";
import type { RouteModule } from "../server.js";

const deckSchema = z.object({
  repoIds: z.array(z.number().int().positive()).length(7),
});

export const collectionRoutes: RouteModule = (app, deps) => {
  const { pool } = deps;

  app.get("/api/collection", async (req) => {
    const user = await requireUser(req, deps);
    const r = await pool.query(
      `SELECT r.id, r.name, r.full_name, r.url, r.owner_login, r.description, r.archived,
              c.source, v.status, v.card, v.grade, v.classification, v.reason, v.updated_at
       FROM user_cards c
       JOIN repositories r ON r.id = c.repo_id
       LEFT JOIN card_versions v ON v.repo_id = r.id
         AND v.season_id = (SELECT id FROM seasons WHERE status = 'active')
       WHERE c.user_id = $1
       ORDER BY c.created_at, r.id`,
      [user.id],
    );
    return {
      cards: r.rows.map((row) => ({
        ...row,
        abilityText: row.card ? describeAbility(row.card) : null,
      })),
    };
  });

  app.get("/api/cards/:id", async (req) => {
    const user = await requireUser(req, deps);
    const id = z.coerce.number().int().positive().parse((req.params as { id: string }).id);
    const r = await pool.query(
      `SELECT r.id, r.name, r.full_name, r.url, r.owner_login, r.description, r.archived,
              v.season_id, v.status, v.card, v.grade, v.classification, v.reason, v.updated_at,
              EXISTS (SELECT 1 FROM user_cards u WHERE u.user_id = $2 AND u.repo_id = r.id) AS owned
       FROM repositories r
       LEFT JOIN card_versions v ON v.repo_id = r.id
       WHERE r.id = $1
         AND (
           EXISTS (SELECT 1 FROM user_cards u WHERE u.user_id = $2 AND u.repo_id = r.id)
           OR EXISTS (SELECT 1 FROM pool_memberships p WHERE p.repo_id = r.id AND p.active)
         )
       ORDER BY v.season_id DESC NULLS LAST`,
      [id, user.id],
    );
    if (!r.rowCount) throw notFound("카드를 찾을 수 없습니다");
    return {
      versions: r.rows.map((row) => ({
        ...row,
        abilityText: row.card ? describeAbility(row.card) : null,
      })),
    };
  });

  app.get("/api/deck", async (req) => {
    const user = await requireUser(req, deps);
    const r = await pool.query<{ repo_ids: number[] }>("SELECT repo_ids FROM decks WHERE user_id = $1", [user.id]);
    return { repoIds: r.rows[0]?.repo_ids ?? [] };
  });

  app.put("/api/deck", async (req) => {
    const user = await requireUser(req, deps, { write: true });
    const { repoIds } = deckSchema.parse(req.body);
    if (new Set(repoIds).size !== 7) throw badRequest("서로 다른 Repo 7장이 필요합니다");
    await transaction(pool, async (c) => {
      const season = await activeSeasonId(c);
      const ready = await c.query<{ count: number }>(
        `SELECT count(*) AS count FROM user_cards uc
         JOIN card_versions v ON v.repo_id = uc.repo_id AND v.season_id = $2 AND v.status = 'ready'
         WHERE uc.user_id = $1 AND uc.repo_id = ANY ($3::bigint[])`,
        [user.id, season, repoIds],
      );
      if (ready.rows[0]!.count !== 7) throw badRequest("보유한 현재 시즌 카드 7장을 선택하세요");
      await c.query(
        `INSERT INTO decks (user_id, repo_ids) VALUES ($1, $2)
         ON CONFLICT (user_id) DO UPDATE SET repo_ids = EXCLUDED.repo_ids, updated_at = now()`,
        [user.id, repoIds],
      );
    });
    return { ok: true };
  });

  app.get("/api/trial", async () => ({
    cards: Object.fromEntries(
      Object.entries(SAMPLE_CARDS).map(([id, card]) => [id, { ...card, abilityText: describeAbility(card) }]),
    ),
    decks: SAMPLE_DECKS,
    description: "가상 프로젝트 체험 덱. 실제 GitHub Repo 카드가 아닙니다.",
  }));
};
