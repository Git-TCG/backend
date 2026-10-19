import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import type pg from "pg";
import { loadEnv, type Env } from "../config/env.js";
import { createSession } from "../http/session.js";
import { buildServer } from "../server.js";

export const TEST_ORIGIN = "http://localhost:8123";

export function testEnv(overrides: Record<string, string> = {}): Env {
  return loadEnv({
    NODE_ENV: "test",
    DATABASE_URL: "postgres://unused",
    CORS_ORIGINS: "localhost,192.168.0.33",
    GITHUB_CLIENT_ID: "client-id",
    GITHUB_CLIENT_SECRET: "client-secret",
    GITHUB_CLASSIC_TOKEN: "classic",
    ...overrides,
  });
}

export interface TestClient {
  userId: number;
  cookie: string;
  csrf: string;
  get: (url: string) => Promise<LightMyRequestResponse>;
  post: (url: string, payload?: unknown) => Promise<LightMyRequestResponse>;
  put: (url: string, payload?: unknown) => Promise<LightMyRequestResponse>;
  del: (url: string) => Promise<LightMyRequestResponse>;
}

export async function createUser(pool: pg.Pool, id: number, fields: { consent?: boolean; allocated?: boolean } = {}) {
  await pool.query(
    `INSERT INTO users (id, login, consent_at, allocated_at) VALUES ($1, $2, $3, $4)`,
    [id, `user${id}`, fields.consent ? new Date() : null, fields.allocated ? new Date() : null],
  );
}

/** 로그인한 사용자 클라이언트. 상태 변경 요청에는 Origin과 CSRF 헤더를 붙인다. */
export async function loginAs(app: FastifyInstance, pool: pg.Pool, userId: number): Promise<TestClient> {
  const token = await createSession(pool, userId);
  const cookie = `tcg_session=${token}`;
  const me = await app.inject({ method: "GET", url: "/api/me", headers: { cookie } });
  const csrf = me.json().csrfToken as string;
  const write = (method: "POST" | "PUT" | "DELETE") => (url: string, payload?: unknown) =>
    app.inject({
      method,
      url,
      headers: { cookie, origin: TEST_ORIGIN, "x-csrf-token": csrf },
      payload: (payload ?? {}) as object,
    });
  return {
    userId,
    cookie,
    csrf,
    get: (url) => app.inject({ method: "GET", url, headers: { cookie } }),
    post: write("POST"),
    put: write("PUT"),
    del: (url) => app.inject({ method: "DELETE", url, headers: { cookie, origin: TEST_ORIGIN, "x-csrf-token": csrf } }),
  };
}

export async function testServer(pool: pg.Pool, env: Env = testEnv()) {
  return buildServer({ env, pool });
}
