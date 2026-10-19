import { afterEach, describe, expect, it, vi } from "vitest";
import { fakeRepo, stubFetch } from "../test/github.js";
import { fakeRepoRoutes, type FakeCommit } from "../test/fake-repo.js";
import { GitHubClient } from "./client.js";
import { classificationInputHash, loadClassificationInput } from "./content.js";
import { collectMetrics, contributorKey, lastTwelveMonths } from "./metrics.js";

const github = new GitHubClient("t");
const NOW = new Date("2026-10-19T12:34:00Z");

/** n개월 전(15일)의 UTC 시각. 1~12 사이면 항상 수집 기간 안이다. */
const monthAgo = (n: number, day = 15) => {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - n, day)).toISOString();
};

describe("수집 기간", () => {
  it("기준 시각이 속한 달을 빼고 직전 12개월을 고른다", () => {
    const w = lastTwelveMonths(NOW);
    expect(w.since.toISOString()).toBe("2025-10-01T00:00:00.000Z");
    expect(w.until.toISOString()).toBe("2026-10-01T00:00:00.000Z");
    expect(w.months).toHaveLength(12);
    expect(w.months[0]).toBe("2025-10");
    expect(w.months[11]).toBe("2026-09");
  });
});

describe("기여자 식별", () => {
  it("연결된 계정은 ID로 세고 봇은 제외한다", () => {
    expect(contributorKey({ author: { id: 5, login: "dev", type: "User" } })).toBe("id:5");
    expect(contributorKey({ author: { id: 6, login: "dependabot", type: "Bot" } })).toBeNull();
    expect(contributorKey({ author: { id: 7, login: "renovate[bot]", type: "User" } })).toBeNull();
  });

  it("연결되지 않은 작성자는 소문자 이메일로 세고, 이메일이 없거나 봇이면 제외한다", () => {
    expect(
      contributorKey({ author: null, commit: { author: { name: "Dev", email: "Dev@Example.COM" } } }),
    ).toBe("email:dev@example.com");
    expect(contributorKey({ author: null, commit: { author: { name: "bot[bot]", email: "b@x.dev" } } })).toBeNull();
    expect(contributorKey({ author: null, commit: { author: { name: "dev", email: "x[bot]@y.dev" } } })).toBeNull();
    expect(contributorKey({ author: null, commit: { author: { name: "dev" } } })).toBeNull();
  });
});

describe("등급 지표 수집", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("커밋·릴리스·스타·포크를 모아 기간 안의 달과 기여자를 센다", async () => {
    const commits: FakeCommit[] = [
      { date: monthAgo(1), authorId: 1 },
      { date: monthAgo(1, 20), authorId: 2 },
      { date: monthAgo(3), authorId: 1 },
      { date: monthAgo(5), email: "Anon@Example.dev", name: "Anon" },
      { date: monthAgo(7), authorId: 9, login: "dependabot[bot]", type: "Bot" },
    ];
    stubFetch(
      fakeRepoRoutes({
        repo: fakeRepo(42, 7, { stargazers_count: 1000, forks_count: 100 }),
        commits,
        releases: [
          { published_at: monthAgo(2) },
          { published_at: monthAgo(4), draft: true },
          { published_at: monthAgo(6), prerelease: true },
          { published_at: monthAgo(14) },
        ],
      }),
    );
    const m = await collectMetrics(github, fakeRepo(42, 7, { stargazers_count: 1000, forks_count: 100 }));
    expect(m.stars).toBe(1000);
    expect(m.forks).toBe(100);
    expect(m.activeMonths).toBe(4); // 봇 커밋의 달도 활동으로 센다
    expect(m.contributors).toBe(3); // 봇은 기여자에서 빠진다
    expect(m.releaseMonths).toBe(1); // draft·prerelease·기간 밖은 제외
    expect(m.contributorsLowerBound).toBe(false);
    expect(m.requests).toBeGreaterThanOrEqual(2);
  });

  it("빈 기본 브랜치(409)는 커밋 0건으로 본다", async () => {
    const repo = fakeRepo(43, 7);
    stubFetch(fakeRepoRoutes({ repo, emptyBranch: true }));
    const m = await collectMetrics(github, repo);
    expect(m.activeMonths).toBe(0);
    expect(m.contributors).toBe(0);
    expect(m.releaseMonths).toBe(0);
    expect(m.contributorsLowerBound).toBe(false);
  });

  it("기여자 상한에 닿으면 페이지를 멈추고 확인 못 한 달은 달마다 직접 확인한다", async () => {
    const commits: FakeCommit[] = [{ date: monthAgo(2), authorId: 1 }];
    for (let i = 1; i <= 10; i++) commits.push({ date: monthAgo(4, (i % 27) + 1), authorId: i });
    for (let i = 0; i < 89; i++) commits.push({ date: monthAgo(4, (i % 27) + 1), authorId: 10 });
    const repo = fakeRepo(44, 7);
    const { calls } = stubFetch(fakeRepoRoutes({ repo, commits }));
    const m = await collectMetrics(github, repo);
    expect(m.contributors).toBe(10);
    expect(m.activeMonths).toBe(2);
    expect(m.contributorsLowerBound).toBe(false); // 상한에 닿아 멈췄으므로 하한값이 아니다
    // 첫 페이지에서 10명에 닿아 멈췄고, 나머지 10개 달을 달마다 확인한다.
    expect(calls.filter((c) => c.endsWith("per_page=1"))).toHaveLength(10);
  });
});

describe("분류 입력", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("README·토픽·파일 구조·언어를 정해진 형태로 모은다", async () => {
    const repo = fakeRepo(45, 7, { description: "d", topics: ["b-topic", "a-topic"] });
    stubFetch(
      fakeRepoRoutes({
        repo,
        readme: "x".repeat(7000),
        files: [
          { name: "src", type: "dir" },
          { name: "README.md", type: "file" },
        ],
        languages: { Go: 50, TypeScript: 100, Rust: 5 },
      }),
    );
    const input = await loadClassificationInput(github, repo);
    expect(input.readme).toHaveLength(6000);
    expect(input.topics).toEqual(["a-topic", "b-topic"]);
    expect(input.languages).toEqual(["TypeScript", "Go", "Rust"]);
    expect(input.rootFiles).toEqual(["README.md", "src/"]);
    expect(input.fullName).toBe(repo.full_name);
  });

  it("README가 없으면 빈 문자열로 둔다", async () => {
    const repo = fakeRepo(46, 7);
    stubFetch(fakeRepoRoutes({ repo, readme: null }));
    const input = await loadClassificationInput(github, repo);
    expect(input.readme).toBe("");
  });

  it("같은 입력은 같은 해시, 입력이 달라지면 해시도 달라진다", async () => {
    const repo = fakeRepo(47, 7);
    stubFetch(fakeRepoRoutes({ repo, readme: "# a" }));
    const a = await loadClassificationInput(github, repo);
    vi.unstubAllGlobals();
    stubFetch(fakeRepoRoutes({ repo, readme: "# b" }));
    const b = await loadClassificationInput(github, repo);
    expect(classificationInputHash(a)).toMatch(/^[0-9a-f]{64}$/);
    expect(classificationInputHash(a)).not.toBe(classificationInputHash(b));
    expect(classificationInputHash(a)).toBe(classificationInputHash({ ...a }));
  });
});
