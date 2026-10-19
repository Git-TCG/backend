import { EFFECTS } from "../engine/effects.js";
import type { Ability, CardDef, EffectId, Grade, Role } from "../engine/types.js";
import { ROLE_EFFECTS, TAG_EFFECTS, type Tag } from "./taxonomy.js";

export const CARD_RULES_VERSION = "card-rules-v0.1";

/** 등급별 비용. 기획서 5장 "전투 설계 방향"에 맞춰 낮은 등급일수록 싸다. */
export const COST_BY_GRADE: Record<Grade, number> = { C: 1, B: 2, A: 3, S: 4, SS: 5 };

/** 등급별 능력 수량(피해·회복·드로우 수). */
export const AMOUNT_BY_GRADE: Record<Grade, number> = { C: 1, B: 1, A: 2, S: 2, SS: 3 };

/** 비용당 전투 수치 예산: 공격력 + 내구도 + 능력 가중치 = 2 × 비용 + 1. */
export const statBudget = (cost: number) => 2 * cost + 1;

/** 능력이 차지하는 예산. 정적 효과는 계속 작용하므로 1을 더한다. */
export function abilityWeight({ effect, amount }: Ability): number {
  const t = EFFECTS[effect];
  const base = t.scalable ? amount : 1;
  return t.trigger === "static" && t.scalable ? base + 1 : base;
}

/** 역할별 공격력 비중. 나머지는 내구도로 간다. */
const ATTACK_SHARE: Record<Role, number> = {
  attack: 0.6,
  defense: 0.35,
  support: 0.5,
  control: 0.5,
  explore: 0.5,
};

export function splitStats(points: number, role: Role): { attack: number; durability: number } {
  const share = ATTACK_SHARE[role];
  let attack = share > 0.5 ? Math.ceil(points * share) : Math.floor(points * share);
  let durability = points - attack;
  if (durability < 1) {
    durability = 1;
    attack = points - 1;
  }
  return { attack, durability };
}

/** FNV-1a. 같은 Repo는 항상 같은 능력 후보를 고르도록 한다. */
export function stableHash(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export function chooseEffect(repoId: string, role: Role, tags: readonly Tag[]): EffectId {
  const allowed = ROLE_EFFECTS[role];
  const fromTags = [...new Set(tags.flatMap((t) => TAG_EFFECTS[t]))].filter((e) => allowed.includes(e));
  const candidates = fromTags.length > 0 ? fromTags : allowed;
  return candidates[stableHash(repoId) % candidates.length]!;
}

export interface BuildCardInput {
  id: string;
  name: string;
  grade: Grade;
  role: Role;
  tags: readonly Tag[];
  /** 지정하면 매핑 대신 이 효과를 쓴다(운영 샘플·시즌 간 능력 유지). 역할에 허용된 효과여야 한다. */
  effect?: EffectId;
}

export function buildCardDefinition(input: BuildCardInput): CardDef {
  const effect = input.effect ?? chooseEffect(input.id, input.role, input.tags);
  if (!ROLE_EFFECTS[input.role].includes(effect)) {
    throw new Error(`${input.role} 역할에는 ${effect} 효과를 줄 수 없습니다`);
  }
  const cost = COST_BY_GRADE[input.grade];
  const ability: Ability = {
    effect,
    amount: EFFECTS[effect].scalable ? AMOUNT_BY_GRADE[input.grade] : 1,
  };
  const points = Math.max(2, statBudget(cost) - abilityWeight(ability));
  return {
    id: input.id,
    name: input.name,
    grade: input.grade,
    role: input.role,
    cost,
    ...splitStats(points, input.role),
    ability,
  };
}
