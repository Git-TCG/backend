/** mulberry32. 상태가 숫자 하나라 MatchState에 그대로 저장하고 재현할 수 있다. */
export function nextRandom(state: number): [value: number, next: number] {
  const next = (state + 0x6d2b79f5) | 0;
  let t = next;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return [((t ^ (t >>> 14)) >>> 0) / 4294967296, next];
}

export interface RngHolder {
  rng: number;
}

export function randomInt(holder: RngHolder, maxExclusive: number): number {
  const [value, next] = nextRandom(holder.rng);
  holder.rng = next;
  return Math.floor(value * maxExclusive);
}

/** Fisher–Yates. 배열을 제자리에서 섞는다. */
export function shuffleInPlace<T>(holder: RngHolder, items: T[]): void {
  for (let i = items.length - 1; i > 0; i--) {
    const j = randomInt(holder, i + 1);
    [items[i], items[j]] = [items[j]!, items[i]!];
  }
}
