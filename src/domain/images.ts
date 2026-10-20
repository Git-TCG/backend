import type pg from "pg";
import { buildImagePrompt, generateCardArt, ImageRejectedError } from "../ai/image.js";
import { SAMPLE_CARDS } from "../cards/samples.js";
import type { Env } from "../config/env.js";
import type { Queryable } from "../db/pool.js";
import type { CardDef } from "../engine/types.js";
import { enqueue } from "../jobs/queue.js";

/** 이미지가 있을 수 있는 카드 ID: Repo ID 또는 체험 덱 sample-NN. */
export const CARD_IMAGE_ID = /^(?:\d{1,15}|sample-\d{2})$/;

export const enqueueCardImage = (q: Queryable, cardId: string) =>
  enqueue(q, "image", `image:${cardId}`, { cardId }, { maxAttempts: 3 });

/** 이미지를 만들 카드 정의. Repo 카드는 가장 최근에 준비된 버전을 쓴다. */
async function loadCard(q: Queryable, cardId: string): Promise<CardDef | null> {
  if (cardId.startsWith("sample-")) return SAMPLE_CARDS[cardId] ?? null;
  const r = await q.query<{ card: CardDef }>(
    `SELECT v.card FROM card_versions v JOIN repositories r ON r.id = v.repo_id
     WHERE v.repo_id = $1 AND v.status = 'ready' AND v.card IS NOT NULL AND r.hidden_at IS NULL
     ORDER BY v.season_id DESC LIMIT 1`,
    [Number(cardId)],
  );
  return r.rows[0]?.card ?? null;
}

export type ImageOutcome = "created" | "exists" | "no-card";

/**
 * 카드 일러스트를 한 번 만든다. 이미 있으면 다시 만들지 않는다(같은 카드는 시즌이 바뀌어도 같은 그림).
 * 안전 필터에 걸리면 이름·콘셉트를 뺀 프롬프트로 한 번 더 시도한다.
 */
export async function generateCardImage(
  deps: { pool: pg.Pool; env: Pick<Env, "OPENAI_API_KEY" | "OPENAI_IMAGE_MODEL"> },
  cardId: string,
): Promise<ImageOutcome> {
  if (!CARD_IMAGE_ID.test(cardId)) throw new Error(`잘못된 카드 ID: ${cardId}`);
  const exists = await deps.pool.query("SELECT 1 FROM card_images WHERE card_id = $1", [cardId]);
  if (exists.rowCount) return "exists";
  const card = await loadCard(deps.pool, cardId);
  if (!card) return "no-card";

  let prompt = buildImagePrompt(card);
  let image;
  try {
    image = await generateCardArt(deps.env, prompt);
  } catch (err) {
    if (!(err instanceof ImageRejectedError)) throw err;
    prompt = buildImagePrompt(card, { safe: true });
    image = await generateCardArt(deps.env, prompt);
  }
  await deps.pool.query(
    `INSERT INTO card_images (card_id, mime, bytes, prompt, model) VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (card_id) DO NOTHING`,
    [cardId, image.mime, image.bytes, prompt, image.model],
  );
  return "created";
}

/** 이미지가 없는 카드(체험 덱 + 준비된 Repo 카드)의 생성 작업을 등록한다. 등록한 수를 돌려준다. */
export async function enqueueMissingImages(q: Queryable): Promise<number> {
  const r = await q.query<{ card_id: string }>(
    `SELECT c.card_id FROM (
       SELECT unnest($1::text[]) AS card_id
       UNION
       SELECT DISTINCT v.repo_id::text FROM card_versions v JOIN repositories r ON r.id = v.repo_id
       WHERE v.status = 'ready' AND v.card IS NOT NULL AND r.hidden_at IS NULL
     ) c
     WHERE NOT EXISTS (SELECT 1 FROM card_images i WHERE i.card_id = c.card_id)
     ORDER BY c.card_id`,
    [Object.keys(SAMPLE_CARDS)],
  );
  for (const { card_id } of r.rows) await enqueueCardImage(q, card_id);
  return r.rows.length;
}
