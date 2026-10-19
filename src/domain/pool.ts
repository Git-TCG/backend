import type { Queryable } from "../db/pool.js";
import { secureRandomIndex, type RandomIndex } from "./random.js";
import { REPO_AVAILABLE_SQL } from "./repositories.js";

export interface PoolCandidate {
  repoId: number;
  ownerId: number;
  weight: number;
}

/**
 * 3장 공정성 규칙: 미보유 카드가 있는 원작자를 먼저 균등하게 고르고, 그 원작자의 Repo를 발급 가중치로 고른다.
 * 조직도 원작자 하나로 취급하므로 Repo가 많은 조직이 과점하지 않는다. 같은 Repo는 한 번만 뽑힌다.
 */
export function drawOwnerFirst(
  candidates: readonly PoolCandidate[],
  count: number,
  random: RandomIndex = secureRandomIndex,
): number[] {
  const byOwner = new Map<number, PoolCandidate[]>();
  for (const c of candidates) {
    const list = byOwner.get(c.ownerId) ?? [];
    if (!list.some((x) => x.repoId === c.repoId)) list.push(c);
    byOwner.set(c.ownerId, list);
  }
  const picked: number[] = [];
  while (picked.length < count && byOwner.size > 0) {
    const owners = [...byOwner.keys()].sort((a, b) => a - b);
    const owner = owners[random(owners.length)]!;
    const repos = byOwner.get(owner)!;
    const total = repos.reduce((sum, r) => sum + r.weight, 0);
    let ticket = random(total);
    const index = repos.findIndex((r) => (ticket -= r.weight) < 0);
    const [chosen] = repos.splice(index, 1);
    picked.push(chosen!.repoId);
    if (repos.length === 0) byOwner.delete(owner);
  }
  return picked;
}

/** 일반 풀에 게시되었고 현재 시즌 카드가 준비된, 사용자가 아직 없는 카드. */
export async function eligiblePoolCards(
  q: Queryable,
  userId: number,
  exclude: readonly number[] = [],
): Promise<PoolCandidate[]> {
  const r = await q.query<{ repo_id: number; owner_id: number; weight: number }>(
    `SELECT p.repo_id, r.owner_id, p.weight
     FROM pool_memberships p
     JOIN repositories r ON r.id = p.repo_id
     JOIN card_versions v ON v.repo_id = p.repo_id AND v.status = 'ready'
       AND v.season_id = (SELECT id FROM seasons WHERE status = 'active')
     WHERE p.pool = 'general' AND p.active AND ${REPO_AVAILABLE_SQL}
       AND NOT EXISTS (SELECT 1 FROM user_cards u WHERE u.user_id = $1 AND u.repo_id = p.repo_id)
       AND NOT (p.repo_id = ANY ($2::bigint[]))`,
    [userId, exclude],
  );
  return r.rows.map((row) => ({ repoId: row.repo_id, ownerId: row.owner_id, weight: row.weight }));
}

export async function drawPoolCards(
  q: Queryable,
  userId: number,
  count: number,
  exclude: readonly number[] = [],
  random?: RandomIndex,
): Promise<number[]> {
  if (count <= 0) return [];
  return drawOwnerFirst(await eligiblePoolCards(q, userId, exclude), count, random);
}
