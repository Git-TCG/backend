import { vi } from "vitest";
import type { GithubRepo } from "../github/repos.js";

export function fakeRepo(id: number, ownerId: number, overrides: Partial<GithubRepo> = {}): GithubRepo {
  const login = `user${ownerId}`;
  return {
    id,
    name: `repo-${id}`,
    full_name: `${login}/repo-${id}`,
    html_url: `https://github.com/${login}/repo-${id}`,
    description: `repo ${id}`,
    owner: { id: ownerId, login, type: "User" },
    private: false,
    fork: false,
    archived: false,
    size: 10,
    default_branch: "main",
    stargazers_count: 1,
    forks_count: 0,
    topics: [],
    ...overrides,
  };
}

export type FakeRoute = (url: URL, init?: RequestInit) => Response | Promise<Response> | undefined;

export const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

/** 전역 fetch를 가짜 GitHub/OpenAI로 바꾼다. 처리하지 않는 주소는 실패시킨다. */
export function stubFetch(...routes: FakeRoute[]) {
  const calls: string[] = [];
  const mock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    calls.push(`${init?.method ?? "GET"} ${url.pathname}${url.search}`);
    for (const route of routes) {
      const res = await route(url, init);
      if (res) return res;
    }
    throw new Error(`unexpected fetch: ${url.href}`);
  });
  vi.stubGlobal("fetch", mock);
  return { mock, calls };
}

/** /user/:id 와 /users/:login/repos 페이지 응답을 흉내 낸다. */
export function githubUserRoutes(userId: number, repos: GithubRepo[], login = `user${userId}`): FakeRoute {
  return (url) => {
    if (url.hostname !== "api.github.com") return undefined;
    if (url.pathname === `/user/${userId}`) return json({ id: userId, login });
    if (url.pathname === `/users/${login}/repos`) {
      const page = Number(url.searchParams.get("page") ?? "1");
      const per = Number(url.searchParams.get("per_page") ?? "30");
      return json(repos.slice((page - 1) * per, page * per));
    }
    return undefined;
  };
}
