import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { loadEnv } from "../config/env.js";
import { createDb, type Db } from "./client.js";

export const migrationsFolder = fileURLToPath(new URL("../../drizzle", import.meta.url));

/** drizzle-kit이 만든 마이그레이션을 적용한다. 아직 생성된 것이 없으면 건너뛴다. */
export async function runMigrations(db: Db): Promise<boolean> {
  if (!existsSync(`${migrationsFolder}/meta/_journal.json`)) return false;
  await migrate(db, { migrationsFolder });
  return true;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { db, pool } = createDb(loadEnv().DATABASE_URL);
  const applied = await runMigrations(db);
  console.log(applied ? "마이그레이션 적용 완료" : "적용할 마이그레이션 없음");
  await pool.end();
}
