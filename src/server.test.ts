import { describe, expect, it } from "vitest";
import { loadEnv } from "./config/env.js";
import { buildServer } from "./server.js";

const env = loadEnv({ NODE_ENV: "test", DATABASE_URL: "postgres://unused" });

describe("GET /health", () => {
  it("DB가 응답하면 200", async () => {
    const app = await buildServer({ env, pool: { query: async () => ({}) } as never });
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "ok", db: "ok" });
  });

  it("DB가 실패하면 503", async () => {
    const app = await buildServer({
      env,
      pool: {
        query: async () => {
          throw new Error("down");
        },
      } as never,
    });
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(503);
  });
});

describe("환경변수", () => {
  it("DATABASE_URL이 없으면 시작하지 않는다", () => {
    expect(() => loadEnv({})).toThrow("DATABASE_URL");
  });

  it("빈 값의 비밀값은 미설정으로 취급하고 CORS 목록을 나눈다", () => {
    const e = loadEnv({ DATABASE_URL: "x", OPENAI_API_KEY: "", CORS_ORIGINS: "https://a.kr, https://b.kr" });
    expect(e.OPENAI_API_KEY).toBeUndefined();
    expect(e.CORS_ORIGINS).toEqual(["https://a.kr", "https://b.kr"]);
    expect(e.PUBLIC_URL).toBe("https://api-tcg.shxin.kr");
  });
});
