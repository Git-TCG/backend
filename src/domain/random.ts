import { randomInt } from "node:crypto";

/** 0 이상 n 미만의 정수. 테스트에서 고정된 함수로 바꿀 수 있다. */
export type RandomIndex = (n: number) => number;

export const secureRandomIndex: RandomIndex = (n) => randomInt(n);

/** Fisher–Yates. 원본 배열은 바꾸지 않는다. */
export function shuffled<T>(items: readonly T[], random: RandomIndex = secureRandomIndex): T[] {
  const a = [...items];
  for (let i = a.length - 1; i > 0; i--) {
    const j = random(i + 1);
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}
