import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type pg from 'pg';
import { loadEnv } from '../config/env.js';
import { createDb } from './client.js';

const path = fileURLToPath(new URL('./schema.sql', import.meta.url));
export async function runMigrations(pool: Pick<pg.Pool,'query'>): Promise<boolean> {
  await pool.query(await readFile(path, 'utf8'));
  return true;
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const {pool} = createDb(loadEnv().DATABASE_URL);
  await runMigrations(pool);
  await pool.end();
}
