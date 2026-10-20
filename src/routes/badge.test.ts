import { afterAll, beforeAll, expect, it } from "vitest";
import { buildCardDefinition } from "../cards/build.js";
import { statsCardSvg, userBadgeSvg } from "../http/badge.js";
import { createUser, loginAs, testServer } from "../test/app.js";
import { createTestDatabase, describeDb, type TestDatabase } from "../test/db.js";

const PIXEL = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

it("상태 카드 SVG에 제목과 값이 들어간다", async () => {
  const svg = await statsCardSvg({
    title: "Repo TCG",
    subtitle: "서버 정상",
    rows: [{ label: "진행 중 대전", value: "2" }],
  });
  expect(svg).toContain("Repo TCG");
  expect(svg).toContain("서버 정상");
  expect(svg).toContain("진행 중 대전");
  expect(svg).toContain(">2<");
  expect(svg).toContain("git-tcg.shxin.kr");
});

it("특수문자는 XML로 이스케이프한다", async () => {
  const svg = await statsCardSvg({ title: `A&B<"`, rows: [{ label: "x", value: "1" }] });
  expect(svg).toContain("A&amp;B&lt;&quot;");
  expect(svg).not.toContain(`A&B<"`);
});

it("전적 카드에 대표 카드 칸을 그린다", async () => {
  const svg = await userBadgeSvg({
    login: "octo",
    cards: [{ name: "검색 드론", grade: "A", role: "explore", cost: 3 }],
    rows: [{ label: "보유 카드", value: "1" }],
  });
  expect(svg).toContain("검색 드론");
  expect(svg).toContain("A등급");
  expect(svg).toContain("빈 칸");
  expect(svg).toContain("git-tcg.shxin.kr");
  expect(svg).toContain("CardCustom");
  expect(svg).toContain("ATK");
});

it("능력 문구를 자르지 않고 다 넣는다", async () => {
  const abilityText = "배포 시: 덱 위 2장 중 1장을 손으로 가져오고, 나머지는 덱 맨 아래로 보낸다.";
  const svg = await userBadgeSvg({
    login: "octo",
    cards: [{ name: "검색 드론", grade: "A", role: "explore", cost: 3, ability: "scout", abilityText }],
    rows: [{ label: "보유 카드", value: "1" }],
  });
  const plain = svg.replace(/<[^>]+>/g, "");
  expect(plain.replace(/\s+/g, "")).toContain(abilityText.replace(/\s+/g, ""));
  expect(svg).not.toContain("…");
});

describeDb("README 배지", () => {
  let db: TestDatabase;
  beforeAll(async () => {
    db = await createTestDatabase();
  });
  afterAll(async () => db?.drop());

  it("서버가 정상이면 상태 SVG와 JSON을 준다", async () => {
    const app = await testServer(db.pool);
    const svg = await app.inject({ method: "GET", url: "/api/badge/status.svg" });
    expect(svg.statusCode).toBe(200);
    expect(svg.headers["content-type"]).toMatch(/image\/svg\+xml/);
    expect(svg.body).toContain("서버 정상");
    expect(svg.body).toContain("git-tcg.shxin.kr");
    expect(svg.body).toContain("30일 가동률");
    expect(svg.body).toContain("측정 중");
    const json = await app.inject({ method: "GET", url: "/api/badge/status" });
    expect(json.json()).toMatchObject({ ok: true, live: 0, uptime: { samples: 0, percent: null } });
    expect(json.json().users).toBeGreaterThanOrEqual(0);
  });

  it("프로브가 있으면 가동률을 퍼센트로 표시한다", async () => {
    const app = await testServer(db.pool);
    const probe = await app.inject({ method: "GET", url: "/api/uptime/probe" });
    expect(probe.statusCode).toBe(200);
    expect(probe.json().ok).toBe(true);
    const svg = await app.inject({ method: "GET", url: "/api/badge/status.svg" });
    expect(svg.body).toContain("100.0%");
    const json = await app.inject({ method: "GET", url: "/api/badge/status" });
    expect(json.json().uptime.percent).toBe(100);
    expect(json.json().uptime.samples).toBe(1);
  });

  it("잘못된 로그인 이름은 400 SVG를 준다", async () => {
    const app = await testServer(db.pool);
    const res = await app.inject({ method: "GET", url: "/api/badge/users/not.valid.svg" });
    expect(res.statusCode).toBe(400);
    expect(res.body).toContain("잘못된 로그인 이름");
  });

  it("없는 사용자는 404 SVG를 준다", async () => {
    const app = await testServer(db.pool);
    const res = await app.inject({ method: "GET", url: "/api/badge/users/nobody.svg" });
    expect(res.statusCode).toBe(404);
    expect(res.body).toContain("없는 사용자");
  });

  it("로그인 이름으로 전적 SVG를 준다", async () => {
    await createUser(db.pool, 42, { consent: true, allocated: true });
    await db.pool.query("UPDATE users SET normal_matches = 3, growth_points = 40, login = 'holy0unjinx' WHERE id = 42");
    const app = await testServer(db.pool);
    const svg = await app.inject({ method: "GET", url: "/api/badge/users/Holy0unjinx.svg" });
    expect(svg.statusCode).toBe(200);
    expect(svg.body).toContain("holy0unjinx");
    expect(svg.body).toContain("정상 대전");
    expect(svg.body).toContain(">3<");
    expect(svg.body).toContain("40 P");
    expect(svg.body).toContain("git-tcg.shxin.kr");
    const json = await app.inject({ method: "GET", url: "/api/badge/users/holy0unjinx" });
    expect(json.json()).toMatchObject({ login: "holy0unjinx", cards: 0, normalMatches: 3, growthPoints: 40 });
  });

  it("대표 카드는 등급 순으로 고르고 설정으로 바꿀 수 있다", async () => {
    await createUser(db.pool, 7, { consent: true, allocated: true });
    const grades = ["C", "B", "A", "S"] as const;
    for (let i = 0; i < grades.length; i++) {
      const grade = grades[i]!;
      const id = 200 + i;
      const card = buildCardDefinition({ id: String(id), name: `카드${grade}`, grade, role: "attack", tags: [] });
      await db.pool.query(
        `INSERT INTO repositories (id, owner_id, owner_login, owner_type, name, full_name, url, default_branch, metadata)
         VALUES ($1, 7, 'u7', 'User', $2, $3, 'https://github.com/u7/r', 'main', '{}')`,
        [id, `r${i}`, `u7/r${i}`],
      );
      await db.pool.query("INSERT INTO card_versions (repo_id, season_id, status, card) VALUES ($1, 1, 'ready', $2)", [
        id,
        JSON.stringify(card),
      ]);
      await db.pool.query("INSERT INTO user_cards (user_id, repo_id, source) VALUES (7, $1, 'initial')", [id]);
      await db.pool.query("INSERT INTO card_images (card_id, mime, bytes, prompt, model) VALUES ($1, 'image/png', $2, 't', 't')", [
        String(id),
        PIXEL,
      ]);
    }
    const app = await testServer(db.pool);
    try {
      const svg = await app.inject({ method: "GET", url: "/api/badge/users/user7.svg" });
      expect(svg.statusCode).toBe(200);
      expect(svg.body).toContain("카드S");
      expect(svg.body).toContain("카드A");
      expect(svg.body).toContain("카드B");
      expect(svg.body).not.toContain("카드C");
      expect(svg.body).toContain("data:image/jpeg;base64,");
      const json = (await app.inject({ method: "GET", url: "/api/badge/users/user7" })).json();
      expect(json.featured.map((c: { name: string }) => c.name)).toEqual(["카드S", "카드A", "카드B"]);

      const client = await loginAs(app, db.pool, 7);
      const saved = await client.put("/api/settings", { badgeCardIds: [200] });
      expect(saved.statusCode).toBe(200);
      expect(saved.json().badgeCardIds).toEqual([200]);
      expect(saved.json().previewIds[0]).toBe(200);
      const after = (await app.inject({ method: "GET", url: "/api/badge/users/user7" })).json();
      expect(after.featured[0].name).toBe("카드C");
      const auto = await client.put("/api/settings", { badgeCardIds: null });
      expect(auto.json().badgeCardIds).toBeNull();
      expect((await client.put("/api/settings", { badgeCardIds: [999] })).statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });
});
