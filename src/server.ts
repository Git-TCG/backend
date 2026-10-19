import cors from "@fastify/cors";
import Fastify from "fastify";
import type pg from "pg";
import type { Env } from "./config/env.js";

export interface AppDeps {
  env: Env;
  pool: Pick<pg.Pool, "query">;
}

export async function buildServer({ env, pool }: AppDeps) {
  const app = Fastify({
    logger: env.NODE_ENV === "test" ? false : { level: env.NODE_ENV === "production" ? "info" : "debug" },
    trustProxy: true,
  });

  await app.register(cors, { origin: env.CORS_ORIGINS, credentials: true });

  app.get("/health", async (_req, reply) => {
    try {
      await pool.query("select 1");
      return { status: "ok", db: "ok" };
    } catch (err) {
      app.log.error({ err }, "health check: db unreachable");
      return reply.code(503).send({ status: "degraded", db: "error" });
    }
  });

  return app;
}
