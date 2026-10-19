import { describe, expect, it } from "vitest";
import { bucketFor, planAllocation } from "./allocation.js";
import { drawOwnerFirst } from "./pool.js";

describe("첫 배정 계획", () => {
  it.each([
    [0, 0, 0, 0],
    [3, 3, 0, 0],
    [7, 7, 0, 0],
    [9, 7, 2, 0],
    [10, 7, 3, 0],
    [15, 7, 3, 5],
  ])("유효 Repo %i개 → 시작 %i, 개인 후보 %i, 공용 후보 %i", (count, initial, personal, pub) => {
    const plan = planAllocation(Array.from({ length: count }, (_, i) => ({ id: i + 1 })));
    expect(plan.filter((p) => p.bucket === "initial")).toHaveLength(initial);
    expect(plan.filter((p) => p.bucket === "personal")).toHaveLength(personal);
    expect(plan.filter((p) => p.bucket === "public")).toHaveLength(pub);
    expect(new Set(plan.map((p) => p.repo.id)).size).toBe(count);
    expect(plan.map((p) => p.position)).toEqual(Array.from({ length: count }, (_, i) => i));
  });

  it("중복 Repo는 하나로 합친다", () => {
    expect(planAllocation([{ id: 1 }, { id: 1 }, { id: 2 }])).toHaveLength(2);
  });

  it("무작위로 섞는다", () => {
    const ids = Array.from({ length: 20 }, (_, i) => ({ id: i }));
    const orders = new Set(Array.from({ length: 5 }, () => planAllocation(ids).map((p) => p.repo.id).join(",")));
    expect(orders.size).toBeGreaterThan(1);
  });

  it("동기화로 추가된 Repo는 개인 한도 10개 안이면 해금 후보, 넘으면 공용 후보이고 즉시 지급하지 않는다", () => {
    expect(bucketFor(3, true)).toBe("personal");
    expect(bucketFor(9, true)).toBe("personal");
    expect(bucketFor(10, true)).toBe("public");
  });
});

describe("원작자 우선 추첨", () => {
  it("Repo가 많은 원작자도 원작자 단위로 균등하게 뽑힌다", () => {
    const big = Array.from({ length: 50 }, (_, i) => ({ repoId: 1000 + i, ownerId: 1, weight: 1 }));
    const small = [{ repoId: 1, ownerId: 2, weight: 1 }];
    let smallWins = 0;
    for (let i = 0; i < 2000; i++) if (drawOwnerFirst([...big, ...small], 1)[0] === 1) smallWins++;
    // 원작자 2명 중 하나를 고르므로 약 50%여야 한다(Repo 단위였다면 약 2%).
    expect(smallWins / 2000).toBeGreaterThan(0.4);
    expect(smallWins / 2000).toBeLessThan(0.6);
  });

  it("같은 원작자 안에서는 발급 가중치를 따른다", () => {
    const repos = [
      { repoId: 1, ownerId: 1, weight: 9 },
      { repoId: 2, ownerId: 1, weight: 1 },
    ];
    let heavy = 0;
    for (let i = 0; i < 2000; i++) if (drawOwnerFirst(repos, 1)[0] === 1) heavy++;
    expect(heavy / 2000).toBeGreaterThan(0.85);
  });

  it("서로 다른 카드만, 후보 수만큼만 뽑는다", () => {
    const repos = [
      { repoId: 1, ownerId: 1, weight: 1 },
      { repoId: 2, ownerId: 1, weight: 1 },
      { repoId: 3, ownerId: 2, weight: 1 },
    ];
    const picked = drawOwnerFirst(repos, 7);
    expect(picked.sort()).toEqual([1, 2, 3]);
    expect(drawOwnerFirst([], 3)).toEqual([]);
  });
});
