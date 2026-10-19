/**
 * 공용 후보 Repo 목록을 등록하고 카드 분석 작업을 건다.
 * 사용: node dist/cli/seed.js content/starter-repos.txt
 * 게시(active)는 관리자 화면에서 카드가 준비된 뒤 한다.
 */
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { loadEnv } from "../config/env.js";
import { upsertRepository } from "../domain/repositories.js";
import { createPool, transaction } from "../db/pool.js";
import { GitHubClient } from "../github/client.js";
import { exclusionReason, fetchRepoByName, parseRepoUrl } from "../github/repos.js";
import { enqueueCard } from "../jobs/kinds.js";

const file = process.argv[2];
if (!file) {
  console.error("사용법: node dist/cli/seed.js <repo-list.txt>");
  process.exit(1);
}

const env = loadEnv();
if (!env.GITHUB_CLASSIC_TOKEN) {
  console.error("GITHUB_CLASSIC_TOKEN이 필요합니다");
  process.exit(1);
}

const text = await readFile(resolve(file), "utf8");
const urls = text
  .split("\n")
  .map((l) => l.trim())
  .filter((l) => l && !l.startsWith("#"));

const pool = createPool(env.DATABASE_URL);
const github = new GitHubClient(env.GITHUB_CLASSIC_TOKEN);
let ok = 0;
let skipped = 0;

try {
  for (const url of urls) {
    const parsed = parseRepoUrl(url);
    if (!parsed) {
      console.warn(`건너뜀(URL): ${url}`);
      skipped++;
      continue;
    }
    const repo = await fetchRepoByName(github, parsed.owner, parsed.name);
    if (!repo) {
      console.warn(`건너뜀(없음): ${url}`);
      skipped++;
      continue;
    }
    const reason = exclusionReason(repo);
    if (reason) {
      console.warn(`건너뜀(${reason}): ${url}`);
      skipped++;
      continue;
    }
    await transaction(pool, async (c) => {
      await upsertRepository(c, repo);
      await c.query(
        `INSERT INTO pool_memberships (repo_id, pool, source, active)
         VALUES ($1, 'general', 'seed', false)
         ON CONFLICT DO NOTHING`,
        [repo.id],
      );
      await enqueueCard(c, repo.id);
    });
    console.log(`등록: ${repo.full_name} (#${repo.id})`);
    ok++;
  }
} finally {
  await pool.end();
}

console.log(`완료: 등록 ${ok}, 건너뜀 ${skipped}`);
