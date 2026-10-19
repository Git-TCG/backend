import { z } from "zod";
import type { EffectId, Role } from "../engine/types.js";

export const ROLES = ["attack", "defense", "support", "control", "explore"] as const satisfies readonly Role[];

/** AI가 고를 수 있는 기능 특성. 이 목록 밖의 값은 버린다. */
export const TAGS = [
  "search",
  "storage",
  "security",
  "automation",
  "generation",
  "game",
  "data",
  "network",
  "ui",
  "devtool",
] as const;
export type Tag = (typeof TAGS)[number];

export const MAX_TAGS = 2;
export const MIN_CONFIDENCE = 0.5;

/** 기능 특성이 시사하는 능력. 역할과 겹치는 것만 후보가 된다. */
export const TAG_EFFECTS: Record<Tag, EffectId[]> = {
  search: ["scout"],
  storage: ["repair", "backup"],
  security: ["shield"],
  automation: ["overclock"],
  generation: ["draw"],
  game: ["rush"],
  data: ["weaken"],
  network: ["strike"],
  ui: ["inspire"],
  devtool: ["fortify"],
};

/** 역할마다 허용되는 능력. 특성이 맞지 않으면 이 목록에서 고른다. */
export const ROLE_EFFECTS: Record<Role, EffectId[]> = {
  attack: ["rush", "strike", "ping"],
  defense: ["shield", "explode", "backup", "fortify"],
  support: ["repair", "inspire", "overclock", "fortify"],
  control: ["freeze", "weaken", "strike"],
  explore: ["scout", "draw", "backup"],
};

export interface Classification {
  role: Role;
  tags: Tag[];
  evidence: string[];
  confidence: number;
  generic: boolean;
}

/** 정보가 부족하거나 응답이 규칙을 어길 때 쓰는 범용 분류. */
export const GENERIC_CLASSIFICATION: Classification = {
  role: "support",
  tags: [],
  evidence: [],
  confidence: 0,
  generic: true,
};

const aiResponseSchema = z.object({
  role: z.enum(ROLES),
  tags: z.array(z.string()),
  evidence: z.array(z.string()).default([]),
  confidence: z.number().min(0).max(1),
});

/** AI 응답을 허용 목록·근거·신뢰도로 검증한다. 실패하면 범용 분류를 돌려준다. */
export function parseClassification(raw: unknown): Classification {
  const parsed = aiResponseSchema.safeParse(raw);
  if (!parsed.success) return GENERIC_CLASSIFICATION;
  const { role, evidence, confidence } = parsed.data;
  if (confidence < MIN_CONFIDENCE || evidence.length === 0) return GENERIC_CLASSIFICATION;
  const tags = [...new Set(parsed.data.tags)].filter((t): t is Tag => (TAGS as readonly string[]).includes(t));
  return { role, tags: tags.slice(0, MAX_TAGS), evidence, confidence, generic: false };
}
