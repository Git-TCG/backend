import { z } from "zod";
import type { Queryable } from "../db/pool.js";
import { featuredCards } from "../domain/featured.js";
import { GRADES } from "../domain/growth.js";
import { formatUptime, recordProbe, uptimeSummary } from "../domain/uptime.js";
import { avatarDataUri } from "../http/embed.js";
import { sendSvg, statsCardSvg, userBadgeSvg } from "../http/badge.js";
import type { RouteModule } from "../server.js";

const loginParam = z
  .string()
  .min(1)
  .max(39)
  .regex(/^[A-Za-z0-9-]+$/);

async function statusPayload(q: Queryable) {
  const [r, uptime] = await Promise.all([
    q.query<{ users: number; live: number; cards: number }>(
      `SELECT
         (SELECT count(*) FROM users WHERE NOT is_bot) AS users,
         (SELECT count(*) FROM matches WHERE ended_at IS NULL) AS live,
         (SELECT count(*) FROM card_versions v
           JOIN seasons s ON s.id = v.season_id AND s.status = 'active'
           WHERE v.status = 'ready') AS cards`,
    ),
    uptimeSummary(q),
  ]);
  return { ...r.rows[0]!, uptime };
}

export const badgeRoutes: RouteModule = (app, deps) => {
  const { pool } = deps;

  app.get("/api/uptime/probe", async () => {
    const checkedAt = await recordProbe(pool);
    return { ok: true, checkedAt: checkedAt.toISOString() };
  });

  app.get("/api/badge/status", async (_req, reply) => {
    try {
      const s = await statusPayload(pool);
      return {
        ok: true,
        users: s.users,
        live: s.live,
        cards: s.cards,
        uptime: s.uptime,
      };
    } catch {
      return reply.code(503).send({ ok: false });
    }
  });

  app.get("/api/badge/status.svg", async (_req, reply) => {
    try {
      const s = await statusPayload(pool);
      return sendSvg(
        reply,
        200,
        await statsCardSvg({
          title: "Repo TCG",
          subtitle: "서버 정상",
          ok: true,
          rows: [
            { label: "진행 중 대전", value: String(s.live) },
            { label: "등록 사용자", value: String(s.users) },
            { label: "발급된 카드", value: String(s.cards) },
            { label: "30일 가동률", value: formatUptime(s.uptime.percent) },
          ],
        }),
        60,
      );
    } catch {
      return sendSvg(
        reply,
        503,
        await statsCardSvg({
          title: "Repo TCG",
          subtitle: "서버 점검 중",
          ok: false,
          rows: [{ label: "상태", value: "연결 실패" }],
        }),
        15,
      );
    }
  });

  app.get("/api/badge/users/:login", async (req, reply) => {
    const parsed = loginParam.safeParse((req.params as { login: string }).login);
    if (!parsed.success) return reply.code(400).send({ error: "잘못된 로그인 이름" });
    const stats = await userStats(pool, parsed.data);
    if (!stats) return reply.code(404).send({ error: "사용자를 찾을 수 없습니다" });
    return {
      login: stats.login,
      name: stats.name,
      avatarUrl: stats.avatarUrl,
      cards: stats.cards,
      normalMatches: stats.normalMatches,
      growthPoints: stats.growthPoints,
      topGrade: stats.topGrade,
      featured: stats.featured.map((c) => ({
        id: c.id,
        name: c.name,
        grade: c.grade,
        role: c.role,
        cost: c.cost,
        attack: c.attack,
        durability: c.durability,
      })),
    };
  });

  app.get("/api/badge/users/:login.svg", async (req, reply) => {
    const parsed = loginParam.safeParse((req.params as { login: string }).login);
    if (!parsed.success) {
      return sendSvg(
        reply,
        400,
        await statsCardSvg({
          title: "Repo TCG",
          subtitle: "잘못된 로그인 이름",
          ok: false,
          rows: [{ label: "상태", value: "요청 오류" }],
        }),
        60,
      );
    }
    const login = parsed.data;
    const stats = await userStats(pool, login);
    if (!stats) {
      return sendSvg(
        reply,
        404,
        await statsCardSvg({
          title: login,
          subtitle: "없는 사용자",
          ok: false,
          rows: [{ label: "상태", value: "없는 사용자" }],
        }),
        60,
      );
    }
    const avatar = await avatarDataUri(stats.avatarUrl);
    return sendSvg(
      reply,
      200,
      await userBadgeSvg({
        login: stats.login,
        name: stats.name,
        avatar,
        cards: stats.featured,
        rows: [
          { label: "보유 카드", value: String(stats.cards) },
          { label: "정상 대전", value: String(stats.normalMatches) },
          { label: "성장 포인트", value: `${stats.growthPoints} P` },
          { label: "최고 등급", value: stats.topGrade ?? "-" },
        ],
      }),
      120,
    );
  });
};

async function userStats(q: Queryable, login: string) {
  const r = await q.query<{
    id: number;
    login: string;
    name: string | null;
    avatar_url: string | null;
    normal_matches: number;
    growth_points: number;
    cards: number;
    badge_card_ids: number[] | null;
  }>(
    `SELECT u.id, u.login, u.name, u.avatar_url, u.normal_matches, u.growth_points, u.badge_card_ids,
            (SELECT count(*) FROM user_cards c WHERE c.user_id = u.id) AS cards
     FROM users u WHERE lower(u.login) = lower($1) AND NOT u.is_bot`,
    [login],
  );
  const row = r.rows[0];
  if (!row) return null;
  const grades = await q.query<{ grade: string | null; upgrade_rank: number }>(
    `SELECT v.card->>'grade' AS grade, uc.upgrade_rank
     FROM user_cards uc
     JOIN card_versions v ON v.repo_id = uc.repo_id AND v.status = 'ready'
       AND v.season_id = (SELECT id FROM seasons WHERE status = 'active')
     WHERE uc.user_id = $1`,
    [row.id],
  );
  let top = -1;
  for (const g of grades.rows) {
    const base = GRADES.indexOf(g.grade as (typeof GRADES)[number]);
    const rank = Math.max(base < 0 ? 0 : base, g.upgrade_rank || 0);
    if (g.grade && rank > top) top = rank;
  }
  const featured = await featuredCards(q, row.id, row.badge_card_ids);
  return {
    login: row.login,
    name: row.name,
    avatarUrl: row.avatar_url,
    cards: row.cards,
    normalMatches: row.normal_matches,
    growthPoints: row.growth_points,
    topGrade: top >= 0 ? GRADES[top]! : null,
    featured,
  };
}
