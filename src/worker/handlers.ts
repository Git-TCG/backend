import type pg from "pg";
import type { Env } from "../config/env.js";
import { allocateInitial, syncNewRepositories } from "../domain/allocation.js";
import { GitHubClient } from "../github/client.js";
import { listOwnedCardRepos } from "../github/repos.js";
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
  };
}
