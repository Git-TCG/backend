import type { EffectId, Trigger } from "./types.js";

export interface EffectTemplate {
  trigger: Trigger;
  /** 배포할 때 상대 프로젝트 하나를 지정해야 하는 효과. */
  targetsEnemyUnit: boolean;
  /** amount가 의미 있는 효과. 아니면 amount는 항상 1이다. */
  scalable: boolean;
  /** 템플릿 설명. 중첩·지속·대상 규칙을 함께 적는다. */
  describe: (amount: number) => string;
}

/**
 * 초기 효과 목록(14종). 순환 조합을 막기 위해 파괴 시 효과는 같은 카드를 다시 필드에 올리지 않고,
 * 피해를 주는 파괴 효과(explode)는 맞은편 한 칸에만 작용한다.
 */
export const EFFECTS: Record<EffectId, EffectTemplate> = {
  rush: {
    trigger: "static",
    targetsEnemyUnit: false,
    scalable: false,
    describe: () => "배포한 턴부터 공격할 수 있다.",
  },
  strike: {
    trigger: "deploy",
    targetsEnemyUnit: true,
    scalable: true,
    describe: (n) => `배포 시: 상대 프로젝트 하나에 ${n} 피해.`,
  },
  ping: {
    trigger: "deploy",
    targetsEnemyUnit: false,
    scalable: true,
    describe: (n) => `배포 시: 상대 코어에 ${n} 피해.`,
  },
  scout: {
    trigger: "deploy",
    targetsEnemyUnit: false,
    scalable: false,
    describe: () => "배포 시: 덱 위 2장 중 1장을 손으로 가져오고, 나머지는 덱 맨 아래로 보낸다.",
  },
  draw: {
    trigger: "deploy",
    targetsEnemyUnit: false,
    scalable: true,
    describe: (n) => `배포 시: 카드 ${n}장을 한 장씩 뽑는다.`,
  },
  repair: {
    trigger: "turnEnd",
    targetsEnemyUnit: false,
    scalable: true,
    describe: (n) =>
      `내 턴 종료 시: 인접 아군 중 가장 많이 손상된 하나의 내구도를 ${n} 회복한다. 최대 내구도를 넘지 않는다.`,
  },
  overclock: {
    trigger: "turnEnd",
    targetsEnemyUnit: false,
    scalable: false,
    describe: () => "내 턴 종료 시: 다음 내 턴에 자원 1을 추가로 얻는다. 중첩되지 않는다.",
  },
  fortify: {
    trigger: "deploy",
    targetsEnemyUnit: false,
    scalable: true,
    describe: (n) => `배포 시: 내 코어 내구도를 ${n} 회복한다. 시작 내구도를 넘지 않는다.`,
  },
  inspire: {
    trigger: "static",
    targetsEnemyUnit: false,
    scalable: true,
    describe: (n) => `필드에 있는 동안: 인접 아군의 공격력 +${n}.`,
  },
  shield: {
    trigger: "static",
    targetsEnemyUnit: false,
    scalable: true,
    describe: (n) => `필드에 있는 동안: 이 프로젝트가 받는 피해를 ${n} 줄인다.`,
  },
  backup: {
    trigger: "destroyed",
    targetsEnemyUnit: false,
    scalable: true,
    describe: (n) => `파괴 시: 카드 ${n}장을 뽑는다.`,
  },
  explode: {
    trigger: "destroyed",
    targetsEnemyUnit: false,
    scalable: true,
    describe: (n) => `파괴 시: 맞은편 상대 프로젝트에 ${n} 피해.`,
  },
  freeze: {
    trigger: "deploy",
    targetsEnemyUnit: true,
    scalable: false,
    describe: () => "배포 시: 상대 프로젝트 하나는 다음 상대 턴에 공격할 수 없다.",
  },
  weaken: {
    trigger: "deploy",
    targetsEnemyUnit: true,
    scalable: true,
    describe: (n) => `배포 시: 상대 프로젝트 하나의 공격력을 ${n} 영구히 낮춘다. 0 미만이 되지 않는다.`,
  },
};
