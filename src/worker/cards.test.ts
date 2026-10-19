import type pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { createUser, testEnv } from "../test/app.js";
import { createTestDatabase, describeDb, type TestDatabase } from "../test/db.js";
import { fakeRepo, json, stubFetch } from "../test/github.js";
import { fakeOpenAI, fakeRepoRoutes, goodClassification, type FakeRepoData } from "../test/fake-repo.js";
import { GitHubClient } from "../github/client.js";
import { enqueueCard } from "../jobs/kinds.js";
import { runNextJob } from "../jobs/worker.js";
import { upsertRepository } from "../domain/repositories.js";
import { generateCardVersion, RULES_VERSION, type CardOutcome } from "../domain/cards.js";
import { createHandlers } from "../worker/handlers.js";

/** n개월 전(15일)의 UTC 시각. 1~12 사이면 항상 수집 기간 안이다. */
const monthAgo = (n: number, day = 15) => {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - n, day)).toISOString();
};

/** 12개월 중 6개월 활동·기여자 3명·2개월 릴리스의 건강한 Repo. stars 1000/forks 100이면 S 등급이다. */
function healthyRepo(repoId: number, ownerId: number): FakeRepoData {
  return {
    repo: fakeRepo(repoId, ownerId, {
      stargazers_count: 1000,
      forks_count: 100,
      description: "full text search engine",
      topics: ["search"],
    }),
    commits: [1, 2, 3, 5, 7, 9].flatMap((n, i) => [
      { date: monthAgo(n), authorId: (i % 2) + 1 },
      { date: monthAgo(n, 20), email: "Anon@Example.dev", name: "Anon" },
    ]),
    releases: [{ published_at: monthAgo(2) }, { published_at: monthAgo(4) }],
    readme: "# search\n문서 전문 검색 엔진",
    files: [
      { name: "src", type: "dir" },
      { name: "README.md", type: "file" },
    ],
    languages: { TypeScript: 100 },
  };
}

const readyOutcome = (o: CardOutcome) => {
  if (o.status !== "ready") throw new Error(`ready가 아닙니다: ${JSON.stringify(o)}`);
  return o;
};

describeDb("카드 생성 파이프라인", () => {
  let db: TestDatabase;
  beforeAll(async () => {
    db = await createTestDatabase();
  });
  afterAll(async () => db?.drop());
  afterEach(() => vi.unstubAllGlobals());
  beforeEach(async () => {
    await db.pool.query("DELETE FROM jobs");
  });

  const env = () => testEnv({ OPENAI_API_KEY: "k", OPENAI_MODEL: "m1" });
  const deps = () => ({ pool: db.pool, env: env(), github: new GitHubClient("t") });

  async function versionRow(pool: pg.Pool, repoId: number, seasonId = 1) {
    const r = await pool.query(
      "SELECT status, card, classification, input_hash, rules_version, reason FROM card_versions WHERE repo_id = $1 AND season_id = $2",
      [repoId, seasonId],
    );
    return r.rows[0] ?? null;
  }

  it("지표 수집 → 등급 → AI 분류 → 능력 매핑을 거쳐 준비된 카드를 발행한다", async () => {
    const data = healthyRepo(500001, 77);
    await upsertRepository(db.pool, data.repo);
    stubFetch(fakeRepoRoutes(data), fakeOpenAI(() => goodClassification));

    const outcome = readyOutcome(await generateCardVersion(deps(), { repoId: 500001, seasonId: 1 }));
    expect(outcome.reused).toBe("none");
    expect(outcome.aiFailed).toBe(false);
    expect(outcome.card.name).toBe("검색 드론"); // AI가 지은 이름
    expect(outcome.card.role).toBe("explore");
    expect(outcome.card.ability?.effect).toBe("scout"); // search 특성이 시사하는 능력
    expect(outcome.card.grade).toBe("S");
    expect(outcome.card.cost).toBe(4);
    expect(outcome.card.source?.fullName).toBe(data.repo.full_name);
    expect(outcome.card.concept).toBe(goodClassification.concept);

    const row = await versionRow(db.pool, 500001);
    expect(row.status).toBe("ready");
    expect(row.rules_version).toBe(RULES_VERSION);
    expect(row.reason).toBeNull();
    expect(row.input_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(row.classification.model).toBe("m1");
    expect(row.classification.aiFailed).toBe(false);

    const jobs = await db.pool.query("SELECT count(*) AS n FROM jobs");
    expect(jobs.rows[0].n).toBe(0);
  });

  it("분류 입력이 그대로면 AI를 다시 부르지 않고 저장된 분류를 재사용한다", async () => {
    const data = healthyRepo(500002, 78);
    await upsertRepository(db.pool, data.repo);
    let aiCalls = 0;
    stubFetch(
      fakeRepoRoutes(data),
      fakeOpenAI(() => {
        aiCalls++;
        return goodClassification;
      }),
    );
    readyOutcome(await generateCardVersion(deps(), { repoId: 500002, seasonId: 1, force: true }));
    expect(aiCalls).toBe(1);

    const again = readyOutcome(await generateCardVersion(deps(), { repoId: 500002, seasonId: 1, force: true }));
    expect(again.reused).toBe("classification");
    expect(aiCalls).toBe(1);
    expect(again.card.name).toBe("검색 드론");
  });

  it("AI가 치명적 오류로 죽으면 범용 타입으로 발행하고 재분석 작업을 미뤄 둔다", async () => {
    const data = healthyRepo(500003, 79);
    await upsertRepository(db.pool, data.repo);
    stubFetch(fakeRepoRoutes(data), fakeOpenAI(() => json({ error: { code: "invalid_api_key" } }, 401)));

    const outcome = readyOutcome(await generateCardVersion(deps(), { repoId: 500003, seasonId: 1 }));
    expect(outcome.aiFailed).toBe(true);
    expect(outcome.card.role).toBe("support"); // 범용 분류
    expect(outcome.card.name).toBe(data.repo.name); // AI 이름이 없어 Repo 이름 사용
    expect(outcome.card.concept).toBeUndefined();

    const row = await versionRow(db.pool, 500003);
    expect(row.status).toBe("ready");
    expect(row.classification.aiFailed).toBe(true);
    expect(row.reason).toContain("AI 분석 실패");

    const retry = await db.pool.query(
      "SELECT payload, available_at > now() + interval '30 minutes' AS later FROM jobs WHERE key = $1",
      ["card:500003:1:ai1"],
    );
    expect(retry.rows[0].later).toBe(true);
    expect(retry.rows[0].payload).toMatchObject({ repoId: 500003, seasonId: 1, force: true, aiRetry: 1 });
  });

  it("지표가 빠지면 보류하고, 회복되면 발행하고, 다시 빠지면 직전 유효 카드를 유지한다", async () => {
    const data = healthyRepo(500004, 80);
    data.repo.stargazers_count = "집계 불가" as unknown as number;
    await upsertRepository(db.pool, data.repo);
    stubFetch(fakeRepoRoutes(data), fakeOpenAI(() => goodClassification));

    const pending = await generateCardVersion(deps(), { repoId: 500004, seasonId: 1 });
    expect(pending.status).toBe("pending");
    expect((pending as { reason: string }).reason).toContain("등급 지표 누락(stars)");
    expect((await versionRow(db.pool, 500004)).status).toBe("pending");

    data.repo.stargazers_count = 1000;
    const ready = readyOutcome(await generateCardVersion(deps(), { repoId: 500004, seasonId: 1, force: true }));
    expect(ready.card.name).toBe("검색 드론");

    data.repo.stargazers_count = null as unknown as number;
    const kept = readyOutcome(await generateCardVersion(deps(), { repoId: 500004, seasonId: 1, force: true }));
    expect(kept.reused).toBe("previous");
    expect(kept.card.name).toBe("검색 드론");
    expect((await versionRow(db.pool, 500004)).status).toBe("ready");
  });

  it("공개 접근이 끊기고 직전 카드도 없으면 error로 기록하고 접근 실패 횟수를 올린다", async () => {
    const repo = fakeRepo(500005, 81);
    await upsertRepository(db.pool, repo);
    stubFetch((url) => (url.pathname === "/repositories/500005" ? json({ message: "Not Found" }, 404) : undefined));

    const outcome = await generateCardVersion(deps(), { repoId: 500005, seasonId: 1 });
    expect(outcome.status).toBe("error");
    expect((outcome as { reason: string }).reason).toContain("공개 Repo에 접근할 수 없습니다");
    expect((await versionRow(db.pool, 500005)).status).toBe("error");
    const r = await db.pool.query("SELECT missing_count FROM repositories WHERE id = 500005");
    expect(r.rows[0].missing_count).toBe(1);
  });

  it("새 시즌에서 접근이 끊기면 직전 시즌의 유효 카드를 그대로 가져온다", async () => {
    const data = healthyRepo(500006, 82);
    await upsertRepository(db.pool, data.repo);
    stubFetch(fakeRepoRoutes(data), fakeOpenAI(() => goodClassification));
    readyOutcome(await generateCardVersion(deps(), { repoId: 500006, seasonId: 1 }));

    await db.pool.query("INSERT INTO seasons (id, status) VALUES (2, 'preparing')");
    vi.unstubAllGlobals();
    stubFetch((url) => (url.pathname === "/repositories/500006" ? json({ message: "Not Found" }, 404) : undefined));

    const kept = readyOutcome(await generateCardVersion(deps(), { repoId: 500006, seasonId: 2 }));
    expect(kept.reused).toBe("previous");
    const row = await versionRow(db.pool, 500006, 2);
    expect(row.status).toBe("ready");
    expect(row.reason).toContain("직전 유효 카드 유지");
    expect(row.card.name).toBe("검색 드론");
  });

  it("운영자가 숨긴 Repo는 GitHub을 부르지 않고 error로 기록한다", async () => {
    const repo = fakeRepo(500007, 83);
    await upsertRepository(db.pool, repo);
    await db.pool.query("UPDATE repositories SET hidden_at = now() WHERE id = 500007");
    const { mock } = stubFetch();

    const outcome = await generateCardVersion(deps(), { repoId: 500007, seasonId: 1 });
    expect(outcome.status).toBe("error");
    expect((outcome as { reason: string }).reason).toContain("운영자가 숨긴 Repo");
    expect(mock).not.toHaveBeenCalled();
  });

  it("준비된 카드는 force 없이 다시 만들지 않고, 지난 시즌 요청은 건너뛴다", async () => {
    const data = healthyRepo(500008, 84);
    await upsertRepository(db.pool, data.repo);
    stubFetch(fakeRepoRoutes(data), fakeOpenAI(() => goodClassification));
    readyOutcome(await generateCardVersion(deps(), { repoId: 500008, seasonId: 1 }));

    const again = await generateCardVersion(deps(), { repoId: 500008, seasonId: 1 });
    expect(again).toEqual({ status: "skipped", reason: "이미 준비된 카드" });

    await db.pool.query("INSERT INTO seasons (id, status) VALUES (9, 'retired')");
    const retired = await generateCardVersion(deps(), { repoId: 500008, seasonId: 9 });
    expect(retired).toEqual({ status: "skipped", reason: "지난 시즌" });
  });

  it("card 작업을 처리하면 카드가 준비되고, 기다리던 신규 사용자의 시작 덱을 채운다", async () => {
    const userId = 601;
    await createUser(db.pool, userId, { consent: true, allocated: true });
    const data = healthyRepo(500009, 85);
    await upsertRepository(db.pool, data.repo);
    await db.pool.query(
      "INSERT INTO pool_memberships (repo_id, pool, source, active) VALUES (500009, 'general', 'seed', true)",
    );
    stubFetch(fakeRepoRoutes(data), fakeOpenAI(() => goodClassification));

    await enqueueCard(db.pool, 500009, 1);
    const handlers = createHandlers({ pool: db.pool, env: env(), github: new GitHubClient("t") });
    expect(await runNextJob(db.pool, handlers)).toBe(true);

    expect((await versionRow(db.pool, 500009)).status).toBe("ready");
    const owned = await db.pool.query("SELECT repo_id, source FROM user_cards WHERE user_id = $1", [userId]);
    expect(owned.rows).toEqual([{ repo_id: 500009, source: "starter_pool" }]);
  });
});
