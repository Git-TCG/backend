import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type pg from "pg";
import { loadEnv } from "../config/env.js";
import { createPool } from "./pool.js";

export const migrationsDir = fileURLToPath(new URL("../../migrations/", import.meta.url));

/** 여러 프로세스가 동시에 시작해도 한 곳만 적용하도록 잡는 advisory lock 번호. */
const MIGRATION_LOCK = 1215902;

export interface MigrationFile {
  version: string;
  sql: string;
  checksum: string;
}

export async function readMigrations(dir = migrationsDir): Promise<MigrationFile[]> {
  const names = (await readdir(dir)).filter((n) => /^\d{3}_[a-z0-9_]+\.sql$/.test(n)).sort();
  return Promise.all(
    names.map(async (name) => {
      const sql = await readFile(`${dir}${name}`, "utf8");
      return { version: name.replace(/\.sql$/, ""), sql, checksum: createHash("sha256").update(sql).digest("hex") };
    }),
  );
}

/**
 * 아직 적용하지 않은 마이그레이션을 순서대로 하나의 트랜잭션에서 적용한다.
 * 이미 적용된 파일의 내용이 바뀌었으면 시작을 거부한다. 변경은 새 번호의 파일로 추가해야 한다.
 */
export async function runMigrations(pool: pg.Pool, dir = migrationsDir): Promise<string[]> {
  const files = await readMigrations(dir);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock($1)", [MIGRATION_LOCK]);
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      version text PRIMARY KEY,
      checksum text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now()
    )`);
    const applied = new Map<string, string>(
      (await client.query("SELECT version, checksum FROM schema_migrations")).rows.map((r) => [r.version, r.checksum]),
    );
    const done: string[] = [];
    for (const file of files) {
      const previous = applied.get(file.version);
      if (previous !== undefined) {
        if (previous !== file.checksum) {
          throw new Error(`이미 적용된 마이그레이션 ${file.version}의 내용이 바뀌었습니다. 새 파일로 추가하세요.`);
        }
        continue;
      }
      await client.query(file.sql);
      await client.query("INSERT INTO schema_migrations (version, checksum) VALUES ($1, $2)", [
        file.version,
        file.checksum,
      ]);
      done.push(file.version);
    }
    await client.query("COMMIT");
    return done;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const pool = createPool(loadEnv().DATABASE_URL);
  try {
    const done = await runMigrations(pool);
    console.log(done.length ? `마이그레이션 적용: ${done.join(", ")}` : "스키마가 최신입니다");
  } finally {
    await pool.end();
  }
}
