import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { allocateInitial, fillWaitingStarters } from "../domain/allocation.js";
import { upsertRepository } from "../domain/repositories.js";
import { GitHubClient } from "../github/client.js";
import { enqueueCollect, enqueueSync } from "../jobs/kinds.js";
import { RetryLaterError } from "../jobs/errors.js";
import { runNextJob } from "../jobs/worker.js";
import { createUser, testEnv } from "../test/app.js";
import { createTestDatabase, describeDb, type TestDatabase } from "../test/db.js";
import { fakeRepo, githubUserRoutes, json, stubFetch } from "../test/github.js";
import { createHandlers } from "./handlers.js";

describeDb("최초 수집·배정 작업", () => {
  let db: TestDatabase;
  let nextUser = 1000;
  beforeAll(async () => {
    db = await createTestDatabase();
  });
  afterAll(async () => db?.drop());
  afterEach(() => vi.unstubAllGlobals());
  beforeEach(async () => {
    await db.pool.query("DELETE FROM jobs");
  });

  const handlers = () => createHandlers({ pool: db.pool, env: testEnv(), github: new GitHubClient("t") });
  const repos = (owner: number, n: number) => Array.from({ length: n }, (_, i) => fakeRepo(owner * 100 + i, owner));

  async function bucketCounts(userId: number) {
    const r = await db.pool.query("SELECT bucket, count(*) AS n FROM allocations WHERE user_id = $1 GROUP BY bucket", [userId]);
    return Object.fromEntries(r.rows.map((x) => [x.bucket, x.n]));
  }

  /** 일반 풀에 게시되고 현재 시즌 카드가 준비된 공용 카드를 만든다. */
  async function seedPublicCard(repoId: number, ownerId: number) {
    await upsertRepository(db.pool, fakeRepo(repoId, ownerId));
    await db.pool.query(
      `INSERT INTO card_versions (repo_id, season_id, status, card) VALUES ($1, 1, 'ready', '{}')`,
      [repoId],
    );
    await db.pool.query(`INSERT INTO pool_memberships (repo_id, pool, source, active) VALUES ($1, 'general', 'seed', true)`, [
      repoId,
    ]);
  }

  it.each([0, 3, 7, 9, 10, 15])("Repo %i개: 경계 사례 배정과 분석 작업 등록", async (n) => {
    const userId = nextUser++;
    await createUser(db.pool, userId, { consent: true });
    stubFetch(githubUserRoutes(userId, repos(userId, n)));
    await enqueueCollect(db.pool, userId);
    expect(await runNextJob(db.pool, handlers())).toBe(true);

    const counts = await bucketCounts(userId);
    expect(counts.initial ?? 0).toBe(Math.min(7, n));
    expect(counts.personal ?? 0).toBe(Math.min(3, Math.max(0, n - 7)));
    expect(counts.public ?? 0).toBe(Math.max(0, n - 10));
    const cardJobs = await db.pool.query("SELECT count(*) AS n FROM jobs WHERE kind = 'card'");
    expect(cardJobs.rows[0].n).toBe(Math.min(7, n));
    const pool = await db.pool.query(
      "SELECT count(*) AS n FROM pool_memberships p JOIN allocations a ON a.repo_id = p.repo_id WHERE a.user_id = $1 AND NOT p.active",
      [userId],
    );
    expect(pool.rows[0].n).toBe(Math.max(0, n - 10));
  });

  it("재시도와 동시 요청에도 배정은 한 번만 일어난다", async () => {
    const userId = nextUser++;
    await createUser(db.pool, userId, { consent: true });
    const list = repos(userId, 12);
    const results = await Promise.all([1, 2, 3].map(() => allocateInitial(db.pool, userId, list)));
    expect(results.filter(Boolean)).toHaveLength(1);
    const before = await db.pool.query("SELECT repo_id, position, bucket FROM allocations WHERE user_id = $1 ORDER BY position", [userId]);
    expect(await allocateInitial(db.pool, userId, [...list].reverse())).toBe(false);
    const after = await db.pool.query("SELECT repo_id, position, bucket FROM allocations WHERE user_id = $1 ORDER BY position", [userId]);
    expect(after.rows).toEqual(before.rows);
    const owned = await db.pool.query("SELECT count(*) AS n FROM user_cards WHERE user_id = $1", [userId]);
    expect(owned.rows[0].n).toBe(7);
  });

  it("본인 카드가 7장 미만이면 게시된 공용 카드로 채우고, 나중에 준비된 카드로 마저 채운다", async () => {
    for (let i = 0; i < 2; i++) await seedPublicCard(900_000 + i, 77);
    const userId = nextUser++;
    await createUser(db.pool, userId, { consent: true });
    await allocateInitial(db.pool, userId, repos(userId, 3));
    let owned = await db.pool.query("SELECT source, count(*) AS n FROM user_cards WHERE user_id = $1 GROUP BY source ORDER BY source", [userId]);
    expect(owned.rows).toEqual([
      { source: "initial", n: 3 },
      { source: "starter_pool", n: 2 },
    ]);

    for (let i = 2; i < 6; i++) await seedPublicCard(900_000 + i, 78 + i);
    expect(await fillWaitingStarters(db.pool)).toBeGreaterThanOrEqual(2);
    owned = await db.pool.query("SELECT count(*) AS n FROM user_cards WHERE user_id = $1", [userId]);
    expect(owned.rows[0].n).toBe(7);
    // 더 채우지 않는다.
    await seedPublicCard(900_100, 99);
    await fillWaitingStarters(db.pool);
    owned = await db.pool.query("SELECT count(*) AS n FROM user_cards WHERE user_id = $1", [userId]);
    expect(owned.rows[0].n).toBe(7);
  });

  it("숨김·접근 불가 Repo와 미게시 카드는 공용 지급에서 빠진다", async () => {
    await seedPublicCard(910_001, 501);
    await seedPublicCard(910_002, 502);
    await seedPublicCard(910_003, 503);
    await db.pool.query("UPDATE repositories SET hidden_at = now() WHERE id = 910001");
    await db.pool.query("UPDATE repositories SET missing_count = 3 WHERE id = 910002");
    await db.pool.query("UPDATE pool_memberships SET active = false WHERE repo_id = 910003");
    const userId = nextUser++;
    await createUser(db.pool, userId, { consent: true });
    await allocateInitial(db.pool, userId, []);
    const owned = (await db.pool.query("SELECT repo_id FROM user_cards WHERE user_id = $1", [userId])).rows.map(
      (r) => r.repo_id,
    );
    expect(owned.length).toBeGreaterThan(0);
    for (const excluded of [910001, 910002, 910003]) expect(owned).not.toContain(excluded);
  });

  it("동기화는 새 Repo를 개인 한도까지 해금 후보로, 이후는 공용 후보로 추가하고 카드는 주지 않는다", async () => {
    const userId = nextUser++;
    await createUser(db.pool, userId, { consent: true });
    const first = repos(userId, 8);
    await allocateInitial(db.pool, userId, first);
    const extra = Array.from({ length: 4 }, (_, i) => fakeRepo(userId * 100 + 50 + i, userId));
    stubFetch(githubUserRoutes(userId, [...first, ...extra]));
    // 이 테스트는 동기화만 검증한다. 배정 때 등록된 카드 분석 작업이 먼저 잡히지 않도록 지운다.
    await db.pool.query("DELETE FROM jobs WHERE kind = 'card'");
    await enqueueSync(db.pool, userId, "2026-10-19");
    await runNextJob(db.pool, handlers());
    expect(await bucketCounts(userId)).toEqual({ initial: 7, personal: 3, public: 2 });
    const owned = await db.pool.query("SELECT count(*) AS n FROM user_cards WHERE user_id = $1", [userId]);
    expect(owned.rows[0].n).toBe(7);
  });

  it("GitHub 한도 초과는 재시도 횟수를 쓰지 않고 미룬다", async () => {
    const userId = nextUser++;
    await createUser(db.pool, userId, { consent: true });
    stubFetch(() => json({}, 403, { "retry-after": "120" }));
    await enqueueCollect(db.pool, userId);
    await runNextJob(db.pool, handlers());
    const job = await db.pool.query(
      "SELECT status, attempts, available_at > now() + interval '100 seconds' AS later FROM jobs WHERE key = $1",
      [`collect:${userId}`],
    );
    expect(job.rows[0]).toEqual({ status: "queued", attempts: 0, later: true });
  });

  it("계속 실패하면 최대 횟수 뒤 error가 되고, 강제 재등록하면 다시 대기한다", async () => {
    const userId = nextUser++;
    await createUser(db.pool, userId, { consent: true });
    stubFetch(() => json({}, 500));
    await db.pool.query(
      `INSERT INTO jobs (kind, key, payload, max_attempts) VALUES ('collect', $1, $2, 2)`,
      [`collect:${userId}`, JSON.stringify({ userId })],
    );
    for (let i = 0; i < 2; i++) {
      await db.pool.query("UPDATE jobs SET available_at = now() WHERE key = $1", [`collect:${userId}`]);
      await runNextJob(db.pool, handlers());
    }
    const failed = await db.pool.query("SELECT status, attempts, last_error FROM jobs WHERE key = $1", [`collect:${userId}`]);
    expect(failed.rows[0]).toMatchObject({ status: "error", attempts: 2 });
    expect(failed.rows[0].last_error).toContain("500");

    await enqueueCollect(db.pool, userId, { force: true });
    const again = await db.pool.query("SELECT status, attempts FROM jobs WHERE key = $1", [`collect:${userId}`]);
    expect(again.rows[0]).toEqual({ status: "queued", attempts: 0 });
  });

  it("처리기가 없는 종류의 작업은 가져가지 않는다", async () => {
    await db.pool.query(`INSERT INTO jobs (kind, key, payload) VALUES ('unknown', 'unknown:1', '{}')`);
    expect(await runNextJob(db.pool, handlers())).toBe(false);
  });

  it("RetryLaterError는 일반 오류와 구분된다", () => {
    expect(new RetryLaterError("x", 1)).toBeInstanceOf(Error);
  });
});
