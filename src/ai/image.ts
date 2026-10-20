import { stableHash } from "../cards/build.js";
import type { CardDef, EffectId, Grade, Role } from "../engine/types.js";
import { RetryLaterError } from "../jobs/errors.js";

export const IMAGE_PROMPT_VERSION = "card-art-v1";
const TIMEOUT_MS = 120_000;

/** 역할별 기본 모습. 같은 역할 안에서도 카드 ID로 변형을 골라 서로 다르게 보이게 한다. */
const ROLE_ARCHETYPE: Record<Role, string[]> = {
  attack: ["an agile battle robot", "a fierce mechanical beast", "a spark-charged war drone", "an armored code knight"],
  defense: ["a towering shield golem", "a fortified crystal turtle", "a vigilant gate guardian", "an armored sentinel construct"],
  support: ["a friendly repair automaton", "a floating helper sprite", "a gentle engineer creature", "a glowing archive keeper"],
  control: ["a mysterious signal sorcerer", "a network-weaving spider construct", "a time-bending clockwork owl", "a hooded data mage"],
  explore: ["a curious scout drone", "a lantern-carrying explorer fox", "a map-reading compass bird", "a deep-sea search submarine creature"],
};

const ROLE_COLOR: Record<Role, string> = {
  attack: "crimson and orange",
  defense: "steel blue and silver",
  support: "emerald green and warm gold",
  control: "deep violet and teal",
  explore: "amber and sky blue",
};

/** 능력이 그림에 드러나도록 넣는 소품·효과. */
const EFFECT_MOTIF: Record<EffectId, string> = {
  rush: "dashing forward with motion streaks",
  strike: "firing a focused energy bolt",
  ping: "launching a small signal missile toward a distant core",
  scout: "scanning two floating cards with a beam of light",
  draw: "pulling glowing cards out of a portal",
  repair: "mending a damaged ally with wrench sparks",
  overclock: "with overheating glowing gears and a power surge",
  fortify: "reinforcing a glowing crystal core",
  inspire: "raising a banner that empowers nearby allies",
  shield: "behind a translucent hexagonal energy barrier",
  backup: "surrounded by floating backup disks",
  explode: "with unstable glowing cracks about to burst",
  freeze: "casting icy frost crystals",
  weaken: "draining color from an opponent with a dim aura",
};

const GRADE_TREATMENT: Record<Grade, string> = {
  C: "simple composition, modest lighting",
  B: "clean composition with a few glowing details",
  A: "dynamic pose, rich lighting and particle effects",
  S: "epic dramatic pose, radiant rim light, intricate details",
  SS: "legendary presence, dazzling aura, cinematic lighting, highly intricate details",
};

const BACKDROPS = [
  "a circuit-board landscape",
  "a server-room canyon",
  "a floating terminal city",
  "a starry data nebula",
  "a neon forest of cables",
  "an ancient library of glowing scrolls",
  "a cloud harbor at dusk",
  "a crystalline cave of code",
];

/** 사용자·AI가 만든 문구는 길이를 제한하고 지시문처럼 보이는 기호를 지운다. */
function clean(text: string | undefined, max: number): string {
  return (text ?? "").replace(/[\r\n<>{}\[\]`"]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
}

const pick = <T>(list: T[], seed: number, salt: number) => list[(seed >>> salt) % list.length]!;

/**
 * 카드 특성(역할·능력·등급·콘셉트)에서 그림 프롬프트를 만든다. 카드 ID로 변형을 고르므로 항상 같은 결과가 나온다.
 * 테두리·글자는 화면에서 그리므로 그림에는 넣지 않는다.
 */
export function buildImagePrompt(card: CardDef, options: { safe?: boolean } = {}): string {
  const seed = stableHash(`${IMAGE_PROMPT_VERSION}:${card.id}`);
  const subject = pick(ROLE_ARCHETYPE[card.role], seed, 0);
  const backdrop = pick(BACKDROPS, seed, 7);
  const motif = card.ability ? EFFECT_MOTIF[card.ability.effect] : "";
  const concept = options.safe ? "" : clean(card.concept, 120);
  const name = options.safe ? "" : clean(card.name, 30);
  return [
    "Trading card game creature illustration for a fantasy card about a software project.",
    `Subject: ${subject}${motif ? `, ${motif}` : ""}.`,
    name ? `The card is called "${name}" (Korean name); reflect its meaning in the design.` : "",
    concept ? `Visual concept (Korean): ${concept}.` : "",
    `Setting: ${backdrop}. Main colors: ${ROLE_COLOR[card.role]}.`,
    `Rarity feel: ${GRADE_TREATMENT[card.grade]}.`,
    "Style: vibrant painterly digital art, single centered subject, clear silhouette, soft background.",
    "Do not include any text, letters, numbers, logos, watermarks, card frames or borders.",
  ]
    .filter(Boolean)
    .join(" ");
}

export interface GeneratedImage {
  bytes: Buffer;
  mime: "image/webp" | "image/png" | "image/jpeg";
  model: string;
}

export class ImageRejectedError extends Error {}

class ModelUnavailableError extends Error {}

async function callImages(apiKey: string, model: string, prompt: string, webp: boolean): Promise<GeneratedImage> {
  const res = await fetch("https://api.openai.com/v1/images/generations", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    signal: AbortSignal.timeout(TIMEOUT_MS),
    body: JSON.stringify(
      model.startsWith("dall-e")
        ? // DALL·E 2는 quality·output_format을 받지 않는다. 가장 싼 512 크기를 쓴다.
          { model, prompt: prompt.slice(0, 1000), n: 1, size: "512x512", response_format: "b64_json" }
        : {
            model,
            prompt,
            n: 1,
            size: "1024x1024",
            quality: "low",
            ...(webp ? { output_format: "webp", output_compression: 80 } : {}),
          },
    ),
  });
  const body = (await res.json().catch(() => null)) as {
    data?: { b64_json?: string }[];
    error?: { code?: string | null; message?: string; param?: string | null };
  } | null;
  if (!res.ok) {
    const code = body?.error?.code ?? "";
    const message = body?.error?.message ?? "";
    if (res.status === 429 && code !== "insufficient_quota") {
      throw new RetryLaterError(`OpenAI 이미지 한도 초과`, 5 * 60_000);
    }
    if (code === "moderation_blocked" || /safety|moderation/i.test(message)) throw new ImageRejectedError(message);
    // 404: 모델 없음. 403: 조직 인증이 필요한 모델 등 이 키로 쓸 수 없는 모델.
    if (res.status === 404 || res.status === 403 || code === "model_not_found") {
      throw new ModelUnavailableError(`모델 ${model} 사용 불가 (${res.status} ${code})`.trim());
    }
    if (res.status === 400 && webp && /output_format|output_compression/i.test(`${body?.error?.param} ${message}`)) {
      return callImages(apiKey, model, prompt, false);
    }
    throw new Error(`OpenAI 이미지 HTTP ${res.status} ${code}`.trim());
  }
  const b64 = body?.data?.[0]?.b64_json;
  if (!b64) throw new Error("OpenAI 이미지 응답에 데이터가 없습니다");
  const bytes = Buffer.from(b64, "base64");
  return { bytes, mime: sniffMime(bytes), model };
}

/** 응답 형식을 실제 바이트로 확인한다(요청한 형식을 무시하는 모델에 대비). */
export function sniffMime(bytes: Buffer): GeneratedImage["mime"] {
  if (bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP") {
    return "image/webp";
  }
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return "image/jpeg";
  if (bytes.subarray(1, 4).toString("ascii") === "PNG") return "image/png";
  throw new Error("알 수 없는 이미지 형식입니다");
}

/**
 * 설정한 모델을 앞에서부터 시도한다. 기본은 저렴한 gpt-image-1-mini(low 품질)이고,
 * 이 키로 쓸 수 없으면 dall-e-2(512px)로 넘어간다.
 */
export async function generateCardArt(
  env: { OPENAI_API_KEY?: string; OPENAI_IMAGE_MODEL: string },
  prompt: string,
): Promise<GeneratedImage> {
  if (!env.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY가 설정되지 않았습니다");
  const models = env.OPENAI_IMAGE_MODEL.split(",").map((m) => m.trim()).filter(Boolean);
  let last: Error = new Error("이미지 모델이 설정되지 않았습니다");
  for (const model of models) {
    try {
      return await callImages(env.OPENAI_API_KEY, model, prompt, true);
    } catch (err) {
      if (!(err instanceof ModelUnavailableError)) throw err;
      last = err;
    }
  }
  throw last;
}
