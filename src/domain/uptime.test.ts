import { afterAll, beforeAll, expect, it } from "vitest";
import { createTestDatabase, describeDb, type TestDatabase } from "../test/db.js";
import { formatUptime, recordProbe, uptimeSummary } from "./uptime.js";

it("측정 전에는 안내 문구를 쓴다", () => {
  expect(formatUptime(null)).toBe("측정 중");
  expect(formatUptime(99.91)).toBe("99.9%");
});

describeDb("가동률", () => {
  let db: TestDatabase;
  beforeAll(async () => {
    db = await createTestDatabase();
  });
  afterAll(async () => db?.drop());

  it("빠진 5분 칸은 다운타임으로 센다", async () => {
    const now = new Date("2026-10-20T13:20:00Z");
    await recordProbe(db.pool, new Date("2026-10-20T13:00:00Z"));
    await recordProbe(db.pool, now);
    const summary = await uptimeSummary(db.pool, now);
    expect(summary.samples).toBe(2);
    expect(summary.percent).toBeCloseTo(40, 5);
  });
});
