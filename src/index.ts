import { loadEnv } from "./config/env.js";
import { runMigrations } from "./db/migrate.js";
import { createPool } from "./db/pool.js";
import { buildServer } from "./server.js";

const env = loadEnv();
const pool = createPool(env.DATABASE_URL);
await runMigrations(pool);

const app = await buildServer({ env, pool });

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, async () => {
    await app.close();
    await pool.end();
    process.exit(0);
  });
}

await app.listen({ host: env.HOST, port: env.PORT });
