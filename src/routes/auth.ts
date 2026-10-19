import { z } from "zod";
import { transaction } from "../db/pool.js";
import { exchangeOAuthCode, fetchOAuthProfile } from "../github/client.js";
import { badRequest, forbidden, unavailable } from "../http/errors.js";
import {
  clearSessionCookie,
  createSession,
  currentUser,
  isAdmin,
  randomToken,
  requestOrigin,
  requireUser,
  setSessionCookie,
  sessionToken,
  sha256,
} from "../http/session.js";
import { enqueueCollect } from "../jobs/kinds.js";
import type { RouteModule } from "../server.js";

export const OAUTH_CALLBACK_PATH = "/api/auth/github";
const STATE_MINUTES = 10;

const callbackQuery = z.object({
  code: z.string().min(1).optional(),
  state: z.string().min(1).max(200).optional(),
  error: z.string().optional(),
});

export const authRoutes: RouteModule = (app, deps) => {
  const { env, pool } = deps;

  // GitHub 로그인 시작. 접속한 웹 Origin에 맞는 Redirect URI를 쓴다.
  app.get("/api/auth/github/start", async (req, reply) => {
    if (!env.GITHUB_CLIENT_ID || !env.GITHUB_CLIENT_SECRET) throw unavailable("GitHub OAuth가 설정되지 않았습니다");
    const origin = requestOrigin(req, env);
    if (!origin) throw forbidden("허용되지 않은 서비스 주소입니다");
    const state = randomToken();
    await pool.query(
      `INSERT INTO oauth_states (state_hash, origin, expires_at)
       VALUES ($1, $2, now() + make_interval(mins => $3))`,
      [sha256(state), origin, STATE_MINUTES],
    );
    const url = new URL("https://github.com/login/oauth/authorize");
    url.searchParams.set("client_id", env.GITHUB_CLIENT_ID);
    url.searchParams.set("redirect_uri", origin + OAUTH_CALLBACK_PATH);
    url.searchParams.set("state", state);
    // 공개 프로필 확인만 하므로 추가 권한(scope)을 요청하지 않는다.
    url.searchParams.set("allow_signup", "true");
    reply.header("Cache-Control", "no-store");
    return reply.redirect(url.toString());
  });

  // GitHub OAuth 콜백. state는 한 번만 쓸 수 있다.
  app.get(OAUTH_CALLBACK_PATH, async (req, reply) => {
    const q = callbackQuery.parse(req.query);
    if (!q.state) throw badRequest("OAuth state가 없습니다");
    const row = await pool.query<{ origin: string }>(
      "DELETE FROM oauth_states WHERE state_hash = $1 AND expires_at > now() RETURNING origin",
      [sha256(q.state)],
    );
    const origin = row.rows[0]?.origin;
    if (!origin) throw badRequest("로그인 요청이 만료되었거나 이미 사용되었습니다. 다시 로그인하세요.");
    reply.header("Cache-Control", "no-store");
    if (q.error || !q.code) return reply.redirect(`${origin}/?login=denied`);
    if (!env.GITHUB_CLIENT_ID || !env.GITHUB_CLIENT_SECRET) throw unavailable("GitHub OAuth가 설정되지 않았습니다");

    let profile;
    try {
      const token = await exchangeOAuthCode(env.GITHUB_CLIENT_ID, env.GITHUB_CLIENT_SECRET, q.code, origin + OAUTH_CALLBACK_PATH);
      profile = await fetchOAuthProfile(token);
    } catch (err) {
      req.log.warn({ err }, "github oauth failed");
      return reply.redirect(`${origin}/?login=error`);
    }

    const session = await transaction(pool, async (c) => {
      await c.query(
        `INSERT INTO users (id, login, name, avatar_url, last_login_at) VALUES ($1, $2, $3, $4, now())
         ON CONFLICT (id) DO UPDATE SET login = EXCLUDED.login, name = EXCLUDED.name,
           avatar_url = EXCLUDED.avatar_url, last_login_at = now()`,
        [profile.id, profile.login, profile.name, profile.avatar_url],
      );
      return createSession(c, profile.id);
    });
    setSessionCookie(reply, session, origin);
    return reply.redirect(`${origin}/?login=ok`);
  });

  app.get("/api/me", async (req, reply) => {
    reply.header("Cache-Control", "no-store");
    const user = await currentUser(req, pool);
    if (!user) return { user: null };
    return {
      user: {
        id: user.id,
        login: user.login,
        name: user.name,
        avatarUrl: user.avatar_url,
        consentAt: user.consent_at,
        allocatedAt: user.allocated_at,
        tokens: user.tokens,
        cosmetics: user.cosmetics,
        normalMatches: user.normal_matches,
        isAdmin: isAdmin(env, user.id),
      },
      csrfToken: user.csrf_token,
    };
  });

  // 게임 내 카드 이용 동의. 로그인과 별도로 기록하고, 동의한 뒤에 Repo 수집을 시작한다.
  app.post("/api/consent", async (req) => {
    const user = await requireUser(req, deps, { write: true });
    await transaction(pool, async (c) => {
      await c.query("UPDATE users SET consent_at = coalesce(consent_at, now()) WHERE id = $1", [user.id]);
      await enqueueCollect(c, user.id);
    });
    return { ok: true };
  });

  app.post("/api/logout", async (req, reply) => {
    await requireUser(req, deps, { write: true });
    await pool.query("DELETE FROM sessions WHERE token_hash = $1", [sha256(sessionToken(req)!)]);
    clearSessionCookie(reply);
    return { ok: true };
  });
};
