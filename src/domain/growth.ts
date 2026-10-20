import type { Queryable } from "../db/pool.js";
import type { CardDef, Grade } from "../engine/types.js";
import { buildCardDefinition } from "../cards/build.js";
import { serviceDay } from "./time.js";

export const GRADES: Grade[] = ["C", "B", "A", "S", "SS"];
export function grownCard(card: CardDef, rank: number): CardDef {
  const grade = GRADES[Math.max(GRADES.indexOf(card.grade), rank)]!;
  if (grade === card.grade) return card;
  return { ...card, ...buildCardDefinition({ id: card.id, name: card.name, role: card.role, grade, tags: [], ...(card.ability ? { effect: card.ability.effect } : {}) }) };
}
export function growthInfo(card: CardDef, rank: number) {
  const current = GRADES.indexOf(grownCard(card, rank).grade);
  return { baseGrade: card.grade, nextGrade: GRADES[current + 1] ?? null, cost: current < 4 ? (current + 1) * 50 : 0 };
}

/** Called inside match settlement's transaction. Lock the wallet before checking the daily cap. */
export async function awardGrowth(q: Queryable, userId: number, matchId: string, practice: boolean) {
  await q.query("SELECT id FROM users WHERE id = $1 FOR UPDATE", [userId]);
  const day = serviceDay();
  if (practice) {
    const count = await q.query<{ count: number }>("SELECT count(*) AS count FROM growth_rewards WHERE user_id = $1 AND day = $2 AND practice", [userId, day]);
    if (Number(count.rows[0]!.count) >= 3) return;
  }
  const grant = await q.query("INSERT INTO growth_rewards (user_id, match_id, day, practice) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING RETURNING user_id", [userId, matchId, day, practice]);
  if (grant.rowCount) await q.query("UPDATE users SET growth_points = growth_points + $2 WHERE id = $1", [userId, practice ? 5 : 10]);
}
