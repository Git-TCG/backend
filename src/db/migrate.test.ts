import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { afterAll, beforeAll, expect, it } from "vitest";
import { createTestDatabase, describeDb, type TestDatabase } from "../test/db.js";
import { readMigrations, runMigrations } from "./migrate.js";

it("마이그레이션 파일은 번호 순서로 읽는다", async () => {
  const files = await readMigrations();
  expect(files[0]?.version).toBe("001_initial");
  expect(files.map((f) => f.version)).toEqual([...files.map((f) => f.version)].sort());
});

describeDb("PostgreSQL 마이그레이션", () => {
  let db: TestDatabase;
  beforeAll(async () => {
    db = await createTestDatabase({ migrate: false });
  });
  afterAll(async () => db?.drop());

  it("처음에는 모두 적용하고, 다시 실행하면 아무것도 하지 않는다", async () => {
    expect(await runMigrations(db.pool)).toContain("001_initial");
    expect(await runMigrations(db.pool)).toEqual([]);
    const season = await db.pool.query("SELECT id, status FROM seasons");
    expect(season.rows).toEqual([{ id: 1, status: "active" }]);
    const bot = await db.pool.query("SELECT id, is_bot FROM users WHERE id = 0");
    expect(bot.rows).toEqual([{ id: 0, is_bot: true }]);
  });

  it("동시에 실행해도 한 번만 적용된다", async () => {
    const other = await createTestDatabase({ migrate: false });
    try {
      const results = await Promise.all([runMigrations(other.pool), runMigrations(other.pool)]);
      expect(results.flat().filter((v) => v === "001_initial")).toHaveLength(1);
    } finally {
      await other.drop();
    }
  });

  it("이미 적용된 파일이 바뀌면 거부한다", async () => {
    const dir = `${await mkdtemp(`${tmpdir()}/mig-`)}/`;
    await writeFile(`${dir}001_initial.sql`, "SELECT 1;");
    await expect(runMigrations(db.pool, dir)).rejects.toThrow("바뀌었습니다");
  });

  it("bigint와 bigint[]는 숫자로 읽는다", async () => {
    const r = await db.pool.query("SELECT 123::bigint AS a, ARRAY[1, 2]::bigint[] AS b, count(*) AS c FROM seasons");
    expect(r.rows[0]).toEqual({ a: 123, b: [1, 2], c: 1 });
  });

  it("활성 시즌과 열린 발견은 하나만 허용한다", async () => {
    await expect(db.pool.query("INSERT INTO seasons (id, status) VALUES (2, 'active')")).rejects.toThrow();
    await db.pool.query("INSERT INTO users (id, login) VALUES (7, 'u7')");
    await db.pool.query(
      `INSERT INTO repositories (id, owner_id, owner_login, owner_type, name, full_name, url, default_branch, metadata)
       VALUES (70, 7, 'u7', 'User', 'r', 'u7/r', 'https://github.com/u7/r', 'main', '{}')`,
    );
    await db.pool.query("INSERT INTO discoveries (user_id, options) VALUES (7, '{70}')");
    await expect(db.pool.query("INSERT INTO discoveries (user_id, options) VALUES (7, '{70}')")).rejects.toThrow();
    await expect(
      db.pool.query("INSERT INTO pool_memberships (repo_id, pool, source) VALUES (70, 'Bad Pool', 'admin')"),
    ).rejects.toThrow();
  });
});
