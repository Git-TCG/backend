import type { Queryable } from "../db/pool.js";
import type { CardDef } from "../engine/types.js";
import { cardArtDataUri } from "../http/embed.js";
import { describeAbility } from "./cards.js";
import { grownCard, GRADES } from "./growth.js";

export interface FeaturedCard {
  id: number;
  name: string;
  grade: string;
  role: string;
  cost: number;
  attack: number;
  durability: number;
  ability: string | null;
  abilityText: string;
  art: string | null;
}

const GRADE_ORDER = `CASE v.card->>'grade' WHEN 'SS' THEN 4 WHEN 'S' THEN 3 WHEN 'A' THEN 2 WHEN 'B' THEN 1 ELSE 0 END`;

type Row = {
  repo_id: number;
  upgrade_rank: number;
  card: CardDef;
  mime: string | null;
  bytes: Buffer | null;
};

async function loadReady(
  q: Queryable,
  userId: number,
  ids?: number[],
): Promise<Row[]> {
  const filter = ids?.length ? `AND uc.repo_id = ANY($2::bigint[])` : "";
  const params: unknown[] = ids?.length ? [userId, ids] : [userId];
  const r = await q.query<Row>(
    `SELECT uc.repo_id, uc.upgrade_rank, v.card, i.mime, i.bytes
     FROM user_cards uc
     JOIN card_versions v ON v.repo_id = uc.repo_id AND v.status = 'ready'
       AND v.season_id = (SELECT id FROM seasons WHERE status = 'active')
       AND v.card IS NOT NULL
     LEFT JOIN card_images i ON i.card_id = uc.repo_id::text
     WHERE uc.user_id = $1 ${filter}
     ORDER BY uc.upgrade_rank DESC, ${GRADE_ORDER} DESC, uc.created_at ASC, uc.repo_id`,
    params,
  );
  return r.rows;
}

function toFeatured(row: Row): Omit<FeaturedCard, "art"> {
  const card = grownCard(row.card, row.upgrade_rank ?? 0);
  return {
    id: row.repo_id,
    name: card.name,
    grade: card.grade,
    role: card.role,
    cost: card.cost,
    attack: card.attack,
    durability: card.durability,
    ability: card.ability?.effect ?? null,
    abilityText: describeAbility(card),
  };
}

/** 설정한 카드가 있으면 그 순서, 없으면 등급 높은 순 최대 3장. 모자라면 자동으로 채운다. */
export async function featuredCards(q: Queryable, userId: number, chosen: number[] | null): Promise<FeaturedCard[]> {
  const picked = chosen?.filter((id) => Number.isInteger(id) && id > 0).slice(0, 3) ?? [];
  const chosenRows = picked.length ? await loadReady(q, userId, picked) : [];
  const byId = new Map(chosenRows.map((row) => [row.repo_id, row]));
  const ordered: Row[] = [];
  for (const id of picked) {
    const row = byId.get(id);
    if (row) ordered.push(row);
  }
  if (ordered.length < 3) {
    const auto = await loadReady(q, userId);
    const have = new Set(ordered.map((r) => r.repo_id));
    for (const row of auto) {
      if (have.has(row.repo_id)) continue;
      ordered.push(row);
      have.add(row.repo_id);
      if (ordered.length >= 3) break;
    }
  }
  return Promise.all(
    ordered.slice(0, 3).map(async (row) => ({
      ...toFeatured(row),
      art: await cardArtDataUri(row.bytes),
    })),
  );
}

export function gradeRank(grade: string | null | undefined): number {
  return Math.max(0, GRADES.indexOf(grade as (typeof GRADES)[number]));
}
