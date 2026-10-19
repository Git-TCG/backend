import { loadEnv } from "../config/env.js";
import { runMigrations } from "../db/migrate.js";
import { createPool } from "../db/pool.js";
import { GitHubClient } from "../github/client.js";
import { runNextJob } from "../jobs/worker.js";
import { createHandlers } from "./handlers.js";

const IDLE_MS = 1000;

const env = loadEnv();
const pool = createPool(env.DATABASE_URL);
await runMigrations(pool);
const handlers = createHandlers({ pool, env, github: new GitHubClient(env.GITHUB_CLASSIC_TOKEN) });

let stopping = false;
for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => (stopping = true));

console.log(`worker started: ${Object.keys(handlers).join(", ")}`);
while (!stopping) {
  let worked = false;
  try {
    worked = await runNextJob(pool, handlers);
  } catch (err) {
    console.error("worker tick failed:", err instanceof Error ? err.message : err);
  }
  if (!worked) await new Promise((r) => setTimeout(r, IDLE_MS));
}
await pool.end();
