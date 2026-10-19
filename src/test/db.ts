import { randomBytes } from "node:crypto";
import pg from "pg";
import { describe } from "vitest";
import { runMigrations } from "../db/migrate.js";
import { createPool } from "../db/pool.js";

/**
 * PostgreSQL이 필요한 테스트. TEST_DATABASE_URL(관리자 권한 DB 주소)이 있을 때만 실행한다.
 * 테스트 파일마다 빈 데이터베이스를 새로 만들어 서로 간섭하지 않게 한다.
 */
export const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
export const describeDb = describe.skipIf(!TEST_DATABASE_URL);

export interface TestDatabase {
  pool: pg.Pool;
  url: string;
  drop: () => Promise<void>;
}

export async function createTestDatabase(options: { migrate?: boolean } = {}): Promise<TestDatabase> {
  if (!TEST_DATABASE_URL) throw new Error("TEST_DATABASE_URL이 필요합니다");
  const name = `tcg_test_${randomBytes(6).toString("hex")}`;
  const admin = new pg.Client({ connectionString: TEST_DATABASE_URL });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${name}`);
  await admin.end();

  const url = new URL(TEST_DATABASE_URL);
  url.pathname = `/${name}`;
  const pool = createPool(url.toString(), 5);
  if (options.migrate !== false) await runMigrations(pool);

  return {
    pool,
    url: url.toString(),
    drop: async () => {
      await pool.end();
      const c = new pg.Client({ connectionString: TEST_DATABASE_URL });
      await c.connect();
      await c.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await c.end();
    },
  };
}
