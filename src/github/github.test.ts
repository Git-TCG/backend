import { afterEach, describe, expect, it, vi } from "vitest";
import { RetryLaterError } from "../jobs/errors.js";
import { fakeRepo, githubUserRoutes, json, stubFetch } from "../test/github.js";
import { GitHubClient, rateLimitDelay } from "./client.js";
import { exclusionReason, listOwnedCardRepos, parseRepoUrl } from "./repos.js";

afterEach(() => vi.unstubAllGlobals());

describe("Repo 수집", () => {
  it("모든 페이지를 읽고 Fork·빈 Repo·프로필 Repo·타인 소유를 제외하며 Archived는 포함한다", async () => {
    const repos = [
      ...Array.from({ length: 150 }, (_, i) => fakeRepo(i + 1, 42)),
      fakeRepo(201, 42, { fork: true }),
      fakeRepo(202, 42, { size: 0 }),
      fakeRepo(203, 42, { name: "User42" }),
      fakeRepo(204, 7),
      fakeRepo(205, 42, { archived: true }),
    ];
    const { calls } = stubFetch(githubUserRoutes(42, repos));
    const result = await listOwnedCardRepos(new GitHubClient("t"), 42);
    expect(result.map((r) => r.id).sort((a, b) => a - b)).toEqual([
      ...Array.from({ length: 150 }, (_, i) => i + 1),
      205,
    ]);
    expect(calls.filter((c) => c.includes("/repos?"))).toHaveLength(2);
  });

  it("로그인 이름이 바뀌어도 계정 ID로 현재 이름을 찾는다", async () => {
    const { calls } = stubFetch(githubUserRoutes(42, [fakeRepo(1, 42)], "renamed"));
    await listOwnedCardRepos(new GitHubClient("t"), 42);
    expect(calls[0]).toBe("GET /user/42");
    expect(calls[1]).toContain("/users/renamed/repos");
  });

  it("제외 이유", () => {
    expect(exclusionReason(fakeRepo(1, 1, { private: true }))).toBe("비공개");
    expect(exclusionReason(fakeRepo(1, 1, { name: ".github" }))).toBe("프로필 소개용 Repo");
    expect(exclusionReason(fakeRepo(1, 1))).toBeNull();
  });
});

describe("GitHub 요청", () => {
  it("한도 초과는 재설정 시각까지 기다리도록 RetryLaterError를 던진다", async () => {
    const reset = Math.floor(Date.now() / 1000) + 120;
    stubFetch(() => json({ message: "rate limited" }, 403, { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(reset) }));
    const err = await new GitHubClient("t").request("/x").catch((e) => e);
    expect(err).toBeInstanceOf(RetryLaterError);
    expect((err as RetryLaterError).delayMs).toBeGreaterThan(100_000);
  });

  it("한도와 관계없는 403은 일반 오류다", () => {
    expect(rateLimitDelay(new Response("", { status: 403 }))).toBeNull();
    expect(rateLimitDelay(new Response("", { status: 403, headers: { "retry-after": "30" } }))).toBe(30_000);
  });

  it("404는 allowNotFound일 때 null", async () => {
    stubFetch(() => json({}, 404));
    expect(await new GitHubClient("t").request("/x", { allowNotFound: true })).toBeNull();
    await expect(new GitHubClient("t").request("/x")).rejects.toThrow("404");
  });

  it("토큰이 없으면 요청하지 않는다", async () => {
    await expect(new GitHubClient(undefined).request("/x")).rejects.toThrow("GITHUB_CLASSIC_TOKEN");
  });
});

describe("Repo URL", () => {
  it.each([
    ["https://github.com/a/b", { owner: "a", name: "b" }],
    ["https://github.com/a/b/", { owner: "a", name: "b" }],
    ["https://github.com/a/b.git", { owner: "a", name: "b" }],
    ["http://github.com/a/b", null],
    ["https://gitlab.com/a/b", null],
    ["https://github.com/a", null],
    ["https://github.com/a/b/tree/main", null],
    ["not a url", null],
  ])("%s", (input, expected) => {
    expect(parseRepoUrl(input)).toEqual(expected);
  });
});
