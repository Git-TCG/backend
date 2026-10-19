import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import type pg from "pg";
import { allowedOrigins, type Env } from "../config/env.js";
import { forbidden, unauthorized } from "./errors.js";

export const SESSION_COOKIE = "tcg_session";
export const SESSION_DAYS = 14;

export const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
export const randomToken = () => randomBytes(32).toString("base64url");

export interface SessionUser {
  id: number;
  login: string;
  name: string | null;
  avatar_url: string | null;
  consent_at: Date | null;
  allocated_at: Date | null;
  tokens: number;
  cosmetics: number;
  normal_matches: number;
  csrf_token: string;
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (header ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i <= 0) continue;
    const key = part.slice(0, i).trim();
    const value = part.slice(i + 1).trim();
    try {
      out[key] = decodeURIComponent(value);
    } catch {
      out[key] = value;
    }
  }
  return out;
}

/** 현재 요청이 들어온 웹 Origin. 허용 목록에 없으면 null. */
export function requestOrigin(req: FastifyRequest, env: Env): string | null {
  const origin = `${req.protocol}://${req.host}`;
  return allowedOrigins(env).includes(origin) ? origin : null;
}

function isSecure(origin: string) {
  return origin.startsWith("https://");
}

export function setSessionCookie(reply: FastifyReply, token: string, origin: string) {
  const secure = isSecure(origin) ? "; Secure" : "";
  reply.header(
    "Set-Cookie",
    `${SESSION_COOKIE}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_DAYS * 86400}${secure}`,
  );
}

export function clearSessionCookie(reply: FastifyReply) {
  reply.header("Set-Cookie", `${SESSION_COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`);
}

export async function createSession(q: Pick<pg.PoolClient, "query">, userId: number): Promise<string> {
  const token = randomToken();
  await q.query(
    `INSERT INTO sessions (token_hash, user_id, csrf_token, expires_at)
     VALUES ($1, $2, $3, now() + make_interval(days => $4))`,
    [sha256(token), userId, randomToken(), SESSION_DAYS],
  );
  return token;
}

export function sessionToken(req: FastifyRequest): string | undefined {
  return parseCookies(req.headers.cookie)[SESSION_COOKIE];
}

export async function currentUser(req: FastifyRequest, pool: pg.Pool): Promise<SessionUser | null> {
  const token = sessionToken(req);
  if (!token) return null;
  const r = await pool.query<SessionUser>(
    `SELECT u.id, u.login, u.name, u.avatar_url, u.consent_at, u.allocated_at, u.tokens, u.cosmetics,
            u.normal_matches, s.csrf_token
     FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = $1 AND s.expires_at > now() AND NOT u.is_bot`,
    [sha256(token)],
  );
  return r.rows[0] ?? null;
}

function safeEqual(a: string, b: string) {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/**
 * 로그인한 사용자를 돌려준다. 상태를 바꾸는 요청(write)은 허용된 Origin과 CSRF 토큰을 함께 요구한다.
 * CSRF 토큰은 같은 Origin의 스크립트만 /api/me 응답으로 읽을 수 있다.
 */
export async function requireUser(
  req: FastifyRequest,
  deps: { pool: pg.Pool; env: Env },
  options: { write?: boolean } = {},
): Promise<SessionUser> {
  const user = await currentUser(req, deps.pool);
  if (!user) throw unauthorized();
  if (options.write) {
    const origin = req.headers.origin;
    if (!origin || !allowedOrigins(deps.env).includes(origin)) throw forbidden("허용되지 않은 요청 출처입니다");
    const csrf = req.headers["x-csrf-token"];
    if (typeof csrf !== "string" || !safeEqual(csrf, user.csrf_token)) throw forbidden("CSRF 토큰이 올바르지 않습니다");
  }
  return user;
}

export function isAdmin(env: Env, userId: number): boolean {
  return env.ADMIN_GITHUB_IDS.includes(userId);
}

export async function requireAdmin(req: FastifyRequest, deps: { pool: pg.Pool; env: Env }, options: { write?: boolean } = {}) {
  const user = await requireUser(req, deps, options);
  if (!isAdmin(deps.env, user.id)) throw forbidden("운영자 권한이 필요합니다");
  return user;
}
