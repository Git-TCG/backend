import cors from "@fastify/cors";
import Fastify from "fastify";
import type pg from "pg";
import {registerRewards} from "./service/rewards.js";
import {registerMatches} from "./service/matches.js";
import {registerCollection} from "./service/collection.js";
import {allowedOrigins,registerAuth} from "./service/auth.js";
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

  await app.register(cors, { origin: allowedOrigins(env), credentials: true });
  if ("connect" in pool) { registerAuth(app,pool as pg.Pool,env); registerCollection(app,pool as pg.Pool,env); registerMatches(app,pool as pg.Pool,env); registerRewards(app,pool as pg.Pool,env); }

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
