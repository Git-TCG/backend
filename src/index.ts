import { loadEnv } from "./config/env.js";
import { createDb } from "./db/client.js";
import { runMigrations } from "./db/migrate.js";
import { buildServer } from "./server.js";

const env = loadEnv();
const { db, pool } = createDb(env.DATABASE_URL);
await runMigrations(db);

const app = await buildServer({ env, pool });

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, async () => {
    await app.close();
    await pool.end();
    process.exit(0);
  });
}

await app.listen({ host: env.HOST, port: env.PORT });
