import type { Queryable } from "../db/pool.js";
import { enqueueCard } from "../jobs/kinds.js";
import { drawPoolCards } from "./pool.js";
import { serviceDay } from "./time.js";

/** 같은 grant_key는 한 번만 들어간다. 새로 넣었으면 true. */
export async function grantReward(
  q: Queryable,
  userId: number,
  grantKey: string,
  kind: "card" | "token" | "cosmetic",
  repoId?: number | null,
): Promise<boolean> {
  const r = await q.query(
    `INSERT INTO reward_grants (user_id, grant_key, kind, repo_id)
     VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING RETURNING user_id`,
    [userId, grantKey, kind, repoId ?? null],
  );
  return (r.rowCount ?? 0) > 0;
}

/**
 * 이정표 보상: 개인 해금 후보 → 공용 풀 → 외형 재화 순으로 지급한다.
 * 같은 키로 재호출해도 중복 지급하지 않는다.
 */
export async function grantMilestone(q: Queryable, userId: number, grantKey: string): Promise<void> {
  const exists = await q.query("SELECT 1 FROM reward_grants WHERE user_id = $1 AND grant_key = $2", [
    userId,
    grantKey,
  ]);
  if (exists.rowCount) return;

  const personal = await q.query<{ repo_id: number }>(
    `SELECT a.repo_id FROM allocations a
     WHERE a.user_id = $1 AND a.bucket = 'personal'
       AND NOT EXISTS (SELECT 1 FROM user_cards u WHERE u.user_id = $1 AND u.repo_id = a.repo_id)
     ORDER BY a.position LIMIT 1`,
    [userId],
  );
  let repoId = personal.rows[0]?.repo_id;
  if (!repoId) {
    const drawn = await drawPoolCards(q, userId, 1);
    repoId = drawn[0];
  }

  if (repoId !== undefined) {
    if (await grantReward(q, userId, grantKey, "card", repoId)) {
      await q.query("INSERT INTO user_cards (user_id, repo_id, source) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING", [
        userId,
        repoId,
        grantKey,
      ]);
      await enqueueCard(q, repoId);
    }
    return;
  }

  if (await grantReward(q, userId, grantKey, "cosmetic")) {
    await q.query("UPDATE users SET cosmetics = cosmetics + 1 WHERE id = $1", [userId]);
  }
}

const MATCH_THRESHOLDS = [3, 7] as const;

/**
 * 정상 대전이 끝나면 보상한다. settled_at이 이미 있으면 아무 것도 하지 않는다.
 * 양측이 실제 행동을 했고 턴이 4 이상일 때만 정상 대전으로 본다(8장).
 */
export async function settleMatchRewards(
  q: Queryable,
  row: {
    id: string;
    player0: number;
    player1: number;
    acted0: number;
    acted1: number;
    settled_at: Date | null;
    state: { result: unknown; turn: number };
  },
): Promise<void> {
  if (row.settled_at || !row.state.result) return;

  // 같은 트랜잭션에서 두 번 호출돼도 한 번만 정산한다.
  const claimed = await q.query(
    `UPDATE matches SET ended_at = coalesce(ended_at, now()), result = $2, settled_at = now()
     WHERE id = $1 AND settled_at IS NULL RETURNING id`,
    [row.id, JSON.stringify(row.state.result)],
  );
  if (!claimed.rowCount) {
    row.settled_at = new Date();
    return;
  }
  row.settled_at = new Date();

  // 봇(0)과의 연습 대전은 정상 대전 보상에서 제외한다. 대신 사람이 실제로 플레이했다면
  // (행동 1회 이상, 4턴 이상) 튜토리얼 완료 보상을 한 번 준다.
  if (row.player0 === 0 || row.player1 === 0) {
    const human = row.player0 === 0 ? row.player1 : row.player0;
    const acted = row.player0 === 0 ? row.acted1 : row.acted0;
    if (acted >= 1 && row.state.turn >= 4) await grantMilestone(q, human, "tutorial");
    return;
  }
  if (row.acted0 < 1 || row.acted1 < 1 || row.state.turn < 4) return;

  for (const [userId, opponentId] of [
    [row.player0, row.player1],
    [row.player1, row.player0],
  ] as const) {
    const day = serviceDay();
    const capped = await q.query(
      `INSERT INTO opponent_days (user_id, opponent_id, day, count) VALUES ($1, $2, $3::date, 1)
       ON CONFLICT (user_id, opponent_id, day) DO UPDATE
         SET count = opponent_days.count + 1
         WHERE opponent_days.count < 3
       RETURNING count`,
      [userId, opponentId, day],
    );
    if (!capped.rowCount) continue;

    const updated = await q.query<{ normal_matches: number }>(
      "UPDATE users SET normal_matches = normal_matches + 1 WHERE id = $1 RETURNING normal_matches",
      [userId],
    );
    const total = updated.rows[0]!.normal_matches;
    for (const threshold of MATCH_THRESHOLDS) {
      if (total === threshold) await grantMilestone(q, userId, `matches:${threshold}`);
    }
    if (await grantReward(q, userId, `daily:${day}`, "token")) {
      await q.query("UPDATE users SET tokens = tokens + 1 WHERE id = $1", [userId]);
    }
  }
}
