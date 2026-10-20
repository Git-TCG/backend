import type pg from "pg";
import type { Env } from "../config/env.js";
import { activateReadyOverflow, allocateInitial, fillWaitingStarters, syncNewRepositories } from "../domain/allocation.js";
import { generateCardVersion, recordCardFailure } from "../domain/cards.js";
import { enqueueCardImage, generateCardImage } from "../domain/images.js";
import { recordRepoMissing, upsertRepository } from "../domain/repositories.js";
import { GitHubClient } from "../github/client.js";
import { fetchRepoById, listOwnedCardRepos } from "../github/repos.js";
import type { JobPayloads } from "../jobs/kinds.js";
import type { Job, JobHandler } from "../jobs/worker.js";

export interface WorkerDeps {
  pool: pg.Pool;
  env: Env;
  github: GitHubClient;
}

const payload = <K extends keyof JobPayloads>(job: Job) => job.payload as JobPayloads[K];

export function createHandlers(deps: WorkerDeps): Record<string, JobHandler> {
  const { pool, github } = deps;
  return {
    collect: {
      run: async (job) => {
        const { userId } = payload<"collect">(job);
        const repos = await listOwnedCardRepos(github, userId);
        await allocateInitial(pool, userId, repos);
      },
    },
    sync: {
      run: async (job) => {
        const { userId } = payload<"sync">(job);
        const repos = await listOwnedCardRepos(github, userId);
        await syncNewRepositories(pool, userId, repos);
      },
    },
    card: {
      run: async (job) => {
        const outcome = await generateCardVersion(deps, payload<"card">(job));
        if (outcome.status === "ready") {
          if (deps.env.OPENAI_API_KEY) await enqueueCardImage(pool, String(payload<"card">(job).repoId));
          const active = await pool.query("SELECT 1 FROM seasons WHERE id = $1 AND status = 'active'", [
            payload<"card">(job).seasonId,
          ]);
          if (active.rowCount) {
            await activateReadyOverflow(pool);
            await fillWaitingStarters(pool);
          }
        }
      },
      onFinalFailure: async (job, error) => {
        const { repoId, seasonId } = payload<"card">(job);
        await recordCardFailure(pool, repoId, seasonId, error.message);
      },
    },
    // 키가 없으면 이미지 작업을 가져가지 않는다. 작업은 남아 있다가 키를 넣고 다시 시작하면 처리된다.
    ...(deps.env.OPENAI_API_KEY
      ? {
          image: {
            run: async (job: Job) => {
              const { cardId } = payload<"image">(job);
              await generateCardImage(deps, cardId);
            },
          },
        }
      : {}),
    refresh: {
      run: async (job) => {
        const { repoId } = payload<"refresh">(job);
        const repo = await fetchRepoById(github, repoId);
        if (!repo) {
          await recordRepoMissing(pool, repoId);
          return;
        }
        await upsertRepository(pool, repo);
      },
    },
  };
}
