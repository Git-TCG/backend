import type { Queryable } from "../db/pool.js";
import type { GithubRepo } from "../github/repos.js";

/** 연속으로 이 횟수만큼 공개 접근에 실패하면 신규 발급과 분석을 멈춘다. */
export const MISSING_LIMIT = 3;

/** 신규 발급·추첨 대상이 될 수 있는 Repo 조건(SQL). r은 repositories 별칭이다. */
export const REPO_AVAILABLE_SQL = `(r.hidden_at IS NULL AND r.missing_count < ${MISSING_LIMIT})`;

/** GitHub 응답으로 Repo 정보를 저장한다. 접근에 성공했으므로 실패 횟수를 초기화한다. */
export async function upsertRepository(q: Queryable, repo: GithubRepo): Promise<void> {
  await q.query(
    `INSERT INTO repositories
       (id, owner_id, owner_login, owner_type, name, full_name, url, description, default_branch, archived, metadata)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     ON CONFLICT (id) DO UPDATE SET
       owner_id = EXCLUDED.owner_id,
       owner_login = EXCLUDED.owner_login,
       owner_type = EXCLUDED.owner_type,
       name = EXCLUDED.name,
       full_name = EXCLUDED.full_name,
       url = EXCLUDED.url,
       description = EXCLUDED.description,
       default_branch = EXCLUDED.default_branch,
       archived = EXCLUDED.archived,
       metadata = EXCLUDED.metadata,
       fetched_at = now(),
       missing_count = 0,
       access_lost_at = NULL`,
    [
      repo.id,
      repo.owner.id,
      repo.owner.login,
      repo.owner.type,
      repo.name,
      repo.full_name,
      repo.html_url,
      repo.description,
      repo.default_branch,
      repo.archived,
      JSON.stringify(repo),
    ],
  );
}

/** 공개 접근에 실패했음을 기록한다. 원인을 삭제나 비공개로 단정하지 않는다. */
export async function recordRepoMissing(q: Queryable, repoId: number): Promise<number> {
  const r = await q.query<{ missing_count: number }>(
    `UPDATE repositories SET missing_count = missing_count + 1, access_lost_at = coalesce(access_lost_at, now())
     WHERE id = $1 RETURNING missing_count`,
    [repoId],
  );
  return r.rows[0]?.missing_count ?? 0;
}
