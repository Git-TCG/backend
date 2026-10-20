import cors from "@fastify/cors";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import type pg from "pg";
import { ZodError } from "zod";
import { allowedOrigins, type Env } from "./config/env.js";
import { HttpError } from "./http/errors.js";
import { adminRoutes } from "./routes/admin.js";
import { authRoutes } from "./routes/auth.js";
import { badgeRoutes } from "./routes/badge.js";
import { collectionRoutes } from "./routes/collection.js";
import { settingsRoutes } from "./routes/settings.js";
import { matchRoutes } from "./routes/matches.js";
import { rewardRoutes } from "./routes/rewards.js";
import { imageRoutes } from "./routes/images.js";
import { statusRoutes } from "./routes/status.js";

export interface AppDeps {
  env: Env;
  pool: pg.Pool;
}

/** 라우트 모듈 형식. 단계별로 server.ts의 ROUTES에 추가한다. */
export type RouteModule = (app: FastifyInstance, deps: AppDeps) => void | Promise<void>;

const ROUTES: RouteModule[] = [
  authRoutes,
  statusRoutes,
  collectionRoutes,
  matchRoutes,
  rewardRoutes,
  adminRoutes,
  imageRoutes,
  badgeRoutes,
  settingsRoutes,
];

export async function buildServer(deps: AppDeps, routes: RouteModule[] = ROUTES) {
  const { env, pool } = deps;
  const app = Fastify({
    logger: env.NODE_ENV === "test" ? false : { level: env.NODE_ENV === "production" ? "info" : "debug" },
    trustProxy: true,
    bodyLimit: 64 * 1024,
  });

  app.setErrorHandler((error: Error & { statusCode?: number; validation?: unknown }, req, reply) => {
    if (error instanceof ZodError) {
      const detail = error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join(", ");
      return reply.code(400).send({ error: `잘못된 요청입니다 (${detail})` });
    }
    if (error instanceof HttpError) return reply.code(error.statusCode).send({ error: error.message });
    // Fastify 자체 4xx(본문 파싱 실패 등)는 그대로 알린다.
    if (typeof error.statusCode === "number" && error.statusCode >= 400 && error.statusCode < 500) {
      return reply.code(error.statusCode).send({ error: error.message });
    }
    req.log.error({ err: error }, "request failed");
    return reply.code(500).send({ error: "서버 오류가 발생했습니다" });
  });

  await app.register(cors, { origin: allowedOrigins(env), credentials: true });

  const health = async (_req: FastifyRequest, reply: FastifyReply) => {
    try {
      await pool.query("select 1");
      return { status: "ok", db: "ok" };
    } catch (err) {
      app.log.error({ err }, "health check: db unreachable");
      return reply.code(503).send({ status: "degraded", db: "error" });
    }
  };
  app.get("/health", health);
  app.get("/api/health", health);

  for (const register of routes) await register(app, deps);
  return app;
}
