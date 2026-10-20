import type { FastifyInstance } from "fastify";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { createUser, loginAs, testServer, TEST_ORIGIN } from "../test/app.js";
import { createTestDatabase, describeDb, type TestDatabase } from "../test/db.js";
import { json, stubFetch } from "../test/github.js";

describeDb("GitHub 로그인과 세션", () => {
  let db: TestDatabase;
  let app: FastifyInstance;
  beforeAll(async () => {
    db = await createTestDatabase();
    app = await testServer(db.pool);
  });
  afterAll(async () => {
    await app?.close();
    await db?.drop();
  });
  afterEach(() => vi.unstubAllGlobals());

  async function startLogin(host: string) {
    const res = await app.inject({ method: "GET", url: "/api/auth/github/start", headers: { host } });
    return res;
  }

  it.each(["localhost:8123", "192.168.0.33:8123"])("%s 에서 시작하면 그 주소의 Redirect URI로 보낸다", async (host) => {
    const res = await startLogin(host);
    expect(res.statusCode).toBe(302);
    const url = new URL(res.headers.location as string);
    expect(url.origin + url.pathname).toBe("https://github.com/login/oauth/authorize");
    expect(url.searchParams.get("redirect_uri")).toBe(`http://${host}/api/auth/github`);
    expect(url.searchParams.get("client_id")).toBe("client-id");
    expect(url.searchParams.get("scope")).toBeNull();
    expect(url.searchParams.get("state")).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it("허용되지 않은 주소에서는 시작하지 않는다", async () => {
    expect((await startLogin("evil.example:8123")).statusCode).toBe(403);
    expect((await startLogin("localhost:9999")).statusCode).toBe(403);
  });

  it("공개 https 도메인에서는 그 Redirect URI로 보낸다", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/auth/github/start",
      headers: { host: "git-tcg.shxin.kr", "x-forwarded-proto": "https" },
    });
    expect(res.statusCode).toBe(302);
    const url = new URL(res.headers.location as string);
    expect(url.searchParams.get("redirect_uri")).toBe("https://git-tcg.shxin.kr/api/auth/github");
  });

  it("콜백은 코드를 교환해 사용자와 세션을 만들고, 같은 state는 다시 쓸 수 없다", async () => {
    const start = await startLogin("192.168.0.33:8123");
    const state = new URL(start.headers.location as string).searchParams.get("state")!;
    const { calls } = stubFetch((url, init) => {
      if (url.href === "https://github.com/login/oauth/access_token") {
        const body = JSON.parse(String(init?.body));
        expect(body).toMatchObject({ code: "the-code", redirect_uri: "http://192.168.0.33:8123/api/auth/github" });
        return json({ access_token: "user-token" });
      }
      if (url.href === "https://api.github.com/user") return json({ id: 9001, login: "octo", name: "Octo", avatar_url: null });
      return undefined;
    });
    const cb = await app.inject({ method: "GET", url: `/api/auth/github?code=the-code&state=${state}` });
    expect(cb.statusCode).toBe(302);
    expect(cb.headers.location).toBe("http://192.168.0.33:8123/?login=ok");
    const cookie = String(cb.headers["set-cookie"]);
    expect(cookie).toMatch(/^tcg_session=[A-Za-z0-9_-]+; HttpOnly; SameSite=Lax; Path=\//);
    expect(calls).toHaveLength(2);

    const me = await app.inject({ method: "GET", url: "/api/me", headers: { cookie: cookie.split(";")[0]! } });
    expect(me.json().user).toMatchObject({ id: 9001, login: "octo", consentAt: null, isAdmin: false });
    expect(me.json().csrfToken).toBeTruthy();

    const again = await app.inject({ method: "GET", url: `/api/auth/github?code=the-code&state=${state}` });
    expect(again.statusCode).toBe(400);
  });

  it("사용자가 GitHub에서 거부하면 화면으로 돌려보낸다", async () => {
    const start = await startLogin("localhost:8123");
    const state = new URL(start.headers.location as string).searchParams.get("state")!;
    const cb = await app.inject({ method: "GET", url: `/api/auth/github?error=access_denied&state=${state}` });
    expect(cb.headers.location).toBe(`${TEST_ORIGIN}/?login=denied`);
  });

  it("상태 변경 요청은 허용된 Origin과 CSRF 토큰을 요구한다", async () => {
    await createUser(db.pool, 501);
    const client = await loginAs(app, db.pool, 501);
    const noOrigin = await app.inject({
      method: "POST",
      url: "/api/consent",
      headers: { cookie: client.cookie, "x-csrf-token": client.csrf },
    });
    expect(noOrigin.statusCode).toBe(403);
    const badOrigin = await app.inject({
      method: "POST",
      url: "/api/consent",
      headers: { cookie: client.cookie, origin: "http://evil.example", "x-csrf-token": client.csrf },
    });
    expect(badOrigin.statusCode).toBe(403);
    const badCsrf = await app.inject({
      method: "POST",
      url: "/api/consent",
      headers: { cookie: client.cookie, origin: TEST_ORIGIN, "x-csrf-token": "nope" },
    });
    expect(badCsrf.statusCode).toBe(403);
    expect((await app.inject({ method: "POST", url: "/api/consent" })).statusCode).toBe(401);
  });

  it("동의하면 수집 작업이 한 번만 등록되고, 로그아웃하면 세션이 사라진다", async () => {
    await createUser(db.pool, 502);
    const client = await loginAs(app, db.pool, 502);
    expect((await client.post("/api/consent")).statusCode).toBe(200);
    expect((await client.post("/api/consent")).statusCode).toBe(200);
    const jobs = await db.pool.query("SELECT kind, key, payload FROM jobs WHERE key = 'collect:502'");
    expect(jobs.rows).toEqual([{ kind: "collect", key: "collect:502", payload: { userId: 502 } }]);
    const status = await client.get("/api/status");
    expect(status.json()).toMatchObject({ consent: true, allocated: false, owned: 0 });

    expect((await client.post("/api/logout")).statusCode).toBe(200);
    expect((await client.get("/api/me")).json()).toEqual({ user: null });
  });

  it("봇 계정으로는 로그인할 수 없다", async () => {
    const client = await loginAs(app, db.pool, 0).catch(() => null);
    expect(client === null || (await client.get("/api/me")).json().user === null).toBe(true);
  });
});
