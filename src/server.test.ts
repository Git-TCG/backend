import type pg from "pg";
import { describe, expect, it } from "vitest";
import { allowedOrigins, loadEnv } from "./config/env.js";
import { buildServer } from "./server.js";

const env = loadEnv({ NODE_ENV: "test", DATABASE_URL: "postgres://unused" });
const poolStub = (query: () => Promise<unknown>) => ({ query }) as unknown as pg.Pool;

describe("GET /health", () => {
  it("DB가 응답하면 200", async () => {
    const app = await buildServer({ env, pool: poolStub(async () => ({})) });
    for (const url of ["/health", "/api/health"]) {
      const res = await app.inject({ method: "GET", url });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ status: "ok", db: "ok" });
    }
  });

  it("DB가 실패하면 503", async () => {
    const app = await buildServer({
      env,
      pool: poolStub(async () => {
        throw new Error("down");
      }),
    });
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(503);
  });
});

describe("환경변수", () => {
  it("DATABASE_URL이 없으면 시작하지 않는다", () => {
    expect(() => loadEnv({})).toThrow("DATABASE_URL");
  });

  it("빈 값의 비밀값은 미설정으로 취급한다", () => {
    const e = loadEnv({ DATABASE_URL: "x", OPENAI_API_KEY: "" });
    expect(e.OPENAI_API_KEY).toBeUndefined();
  });

  it("ADMIN_GITHUB_IDS는 숫자 ID만 허용한다", () => {
    expect(loadEnv({ DATABASE_URL: "x", ADMIN_GITHUB_IDS: "1, 42" }).ADMIN_GITHUB_IDS).toEqual([1, 42]);
    expect(() => loadEnv({ DATABASE_URL: "x", ADMIN_GITHUB_IDS: "holy0unjinx" })).toThrow("숫자");
  });

  it("호스트만 적은 CORS_ORIGINS는 웹 포트 8123의 http Origin이 된다", () => {
    const e = loadEnv({
      DATABASE_URL: "x",
      CORS_ORIGINS: "192.168.0.33,localhost, https://git-tcg.shxin.kr ,bad/path",
    });
    expect(allowedOrigins(e)).toEqual([
      "http://192.168.0.33:8123",
      "http://localhost:8123",
      "https://git-tcg.shxin.kr",
    ]);
  });
});
