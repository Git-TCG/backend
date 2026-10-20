import type pg from "pg";
import { RULES } from "../engine/engine.js";
import { transaction, type Queryable } from "../db/pool.js";
import type { GithubRepo } from "../github/repos.js";
import { enqueueCard } from "../jobs/kinds.js";
import { drawPoolCards } from "./pool.js";
import { secureRandomIndex, shuffled, type RandomIndex } from "./random.js";
import { upsertRepository } from "./repositories.js";

/** 시즌마다 리셋하지 않는 개인 우선 배정 한도(시작 7장 + 개인 해금 후보 3장). */
export const PERSONAL_LIMIT = 10;
export const STARTER_SIZE = RULES.deckSize;

export type Bucket = "initial" | "personal" | "public";

export function bucketFor(position: number, alreadyGranted: boolean): Bucket {
  if (position < STARTER_SIZE && !alreadyGranted) return "initial";
  return position < PERSONAL_LIMIT ? "personal" : "public";
}

/** 2장 첫 배정: 중복 없이 섞어 앞 7개 즉시 지급, 다음 3개 개인 해금 후보, 나머지 공용 후보. */
export function planAllocation<T extends { id: number }>(repos: readonly T[], random: RandomIndex = secureRandomIndex) {
  const unique = [...new Map(repos.map((r) => [r.id, r])).values()];
  return shuffled(unique, random).map((repo, position) => ({ repo, position, bucket: bucketFor(position, false) }));
}

async function addOwnerOverflowToPool(q: Queryable, repoId: number) {
  await q.query(
    `INSERT INTO pool_memberships (repo_id, pool, source) VALUES ($1, 'general', 'owner_overflow')
     ON CONFLICT DO NOTHING`,
    [repoId],
  );
  // 공용 후보는 지급 때 분석해도 되지만, 풀에 안 보이면 없는 카드처럼 보이므로 바로 만든다.
  await enqueueCard(q, repoId);
}

/** 카드가 준비된 초과 Repo를 일반 풀에 게시한다. 운영자가 올린 미게시 카드는 건드리지 않는다. */
export async function activateReadyOverflow(q: Queryable): Promise<number> {
  const r = await q.query(
    `UPDATE pool_memberships p SET active = true
     WHERE p.pool = 'general' AND p.source = 'owner_overflow' AND NOT p.active
       AND EXISTS (
         SELECT 1 FROM card_versions v
         WHERE v.repo_id = p.repo_id AND v.status = 'ready'
           AND v.season_id = (SELECT id FROM seasons WHERE status = 'active')
       )
     RETURNING p.repo_id`,
  );
  return r.rowCount ?? 0;
}

/** 아직 카드가 없는 초과 Repo의 분석 작업을 올린다. 워커 시작 때 기존 후보를 살린다. */
export async function enqueueUnanalyzedOverflow(q: Queryable): Promise<number> {
  const r = await q.query<{ repo_id: number }>(
    `SELECT p.repo_id FROM pool_memberships p
     WHERE p.pool = 'general' AND p.source = 'owner_overflow'
       AND NOT EXISTS (
         SELECT 1 FROM card_versions v
         WHERE v.repo_id = p.repo_id AND v.status = 'ready'
           AND v.season_id = (SELECT id FROM seasons WHERE status = 'active')
       )`,
  );
  for (const { repo_id } of r.rows) await enqueueCard(q, repo_id, undefined, { force: true });
  return r.rows.length;
}

/**
 * 최초 배정. 추첨 결과를 먼저 영구 저장한 뒤 분석 작업을 등록한다.
 * 이미 배정된 사용자는 아무것도 바꾸지 않으므로 재로그인·중복 요청에도 같은 결과가 유지된다.
 * @returns 새로 배정했으면 true
 */
export async function allocateInitial(
  pool: pg.Pool,
  userId: number,
  repos: readonly GithubRepo[],
  random?: RandomIndex,
): Promise<boolean> {
  return transaction(pool, async (c) => {
    const user = await c.query<{ allocated_at: Date | null }>("SELECT allocated_at FROM users WHERE id = $1 FOR UPDATE", [
      userId,
    ]);
    if (!user.rows[0]) throw new Error(`사용자 없음: ${userId}`);
    if (user.rows[0].allocated_at) return false;

    for (const { repo, position, bucket } of planAllocation(repos, random)) {
      await upsertRepository(c, repo);
      await c.query("INSERT INTO allocations (user_id, repo_id, position, bucket) VALUES ($1, $2, $3, $4)", [
        userId,
        repo.id,
        position,
        bucket,
      ]);
      if (bucket === "initial") {
        await c.query("INSERT INTO user_cards (user_id, repo_id, source) VALUES ($1, $2, 'initial')", [userId, repo.id]);
        await enqueueCard(c, repo.id);
      }
      if (bucket === "public") await addOwnerOverflowToPool(c, repo.id);
    }
    await c.query("UPDATE users SET allocated_at = now() WHERE id = $1", [userId]);
    await fillStarterInTx(c, userId);
    return true;
  });
}

/**
 * 신규 Repo 동기화. 개인 한도가 남으면 해금 후보로, 가득 찼으면 공용 후보로 분류한다.
 * 후보 추가만으로 카드를 지급하지 않는다. 기존 Repo는 정보만 갱신한다.
 * @returns 새로 분류한 Repo 수
 */
export async function syncNewRepositories(pool: pg.Pool, userId: number, repos: readonly GithubRepo[]): Promise<number> {
  return transaction(pool, async (c) => {
    const user = await c.query<{ allocated_at: Date | null }>("SELECT allocated_at FROM users WHERE id = $1 FOR UPDATE", [
      userId,
    ]);
    if (!user.rows[0]?.allocated_at) return 0;
    const existing = await c.query<{ repo_id: number; position: number }>(
      "SELECT repo_id, position FROM allocations WHERE user_id = $1",
      [userId],
    );
    const known = new Set(existing.rows.map((r) => r.repo_id));
    let position = existing.rows.reduce((max, r) => Math.max(max, r.position + 1), 0);
    let added = 0;
    for (const repo of repos) {
      await upsertRepository(c, repo);
      if (known.has(repo.id)) continue;
      const bucket = bucketFor(position, true);
      await c.query("INSERT INTO allocations (user_id, repo_id, position, bucket) VALUES ($1, $2, $3, $4)", [
        userId,
        repo.id,
        position,
        bucket,
      ]);
      if (bucket === "public") await addOwnerOverflowToPool(c, repo.id);
      known.add(repo.id);
      position++;
      added++;
    }
    return added;
  });
}

/**
 * 시작 카드가 7장 미만이면 일반 풀에서 부족분을 채운다. 가입 보상은 재화로 대체하지 않으므로
 * 풀이 부족하면 채울 수 있는 만큼만 채우고, 카드가 준비되면 다시 호출한다.
 * 호출자가 사용자 행을 잠근 트랜잭션 안에서 실행해야 한다.
 */
export async function fillStarterInTx(c: Queryable, userId: number, random?: RandomIndex): Promise<number> {
  const owned = await c.query<{ count: number }>("SELECT count(*) AS count FROM user_cards WHERE user_id = $1", [userId]);
  const missing = STARTER_SIZE - owned.rows[0]!.count;
  if (missing <= 0) return 0;
  const picks = await drawPoolCards(c, userId, missing, [], random);
  for (const repoId of picks) {
    await c.query("INSERT INTO user_cards (user_id, repo_id, source) VALUES ($1, $2, 'starter_pool')", [userId, repoId]);
  }
  return picks.length;
}

/** 시작 카드가 모자란 모든 사용자에게 부족분을 채운다. 공용 카드가 준비·게시될 때 호출한다. */
export async function fillWaitingStarters(pool: pg.Pool): Promise<number> {
  const waiting = await pool.query<{ id: number }>(
    `SELECT u.id FROM users u
     WHERE u.allocated_at IS NOT NULL
       AND (SELECT count(*) FROM user_cards c WHERE c.user_id = u.id) < $1`,
    [STARTER_SIZE],
  );
  let filled = 0;
  for (const { id } of waiting.rows) {
    filled += await transaction(pool, async (c) => {
      await c.query("SELECT 1 FROM users WHERE id = $1 FOR UPDATE", [id]);
      return fillStarterInTx(c, id);
    });
  }
  return filled;
}
