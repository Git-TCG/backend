import type { GithubRepo } from "../github/repos.js";
import { json, type FakeRoute } from "./github.js";

export interface FakeCommit {
  date: string;
  authorId?: number;
  login?: string;
  type?: string;
  email?: string;
  name?: string;
}

export interface FakeRepoData {
  repo: GithubRepo;
  commits?: FakeCommit[];
  releases?: { published_at: string | null; created_at?: string; draft?: boolean; prerelease?: boolean }[];
  readme?: string | null;
  files?: { name: string; type: "file" | "dir" }[];
  languages?: Record<string, number>;
  /** 기본 브랜치가 비어 있어 커밋 API가 409를 돌려준다. */
  emptyBranch?: boolean;
}

/** /repositories/:id 와 /repos/:owner/:name/* 를 흉내 낸다. 커밋은 since/until/page를 지원한다. */
export function fakeRepoRoutes(...repos: FakeRepoData[]): FakeRoute {
  return (url) => {
    if (url.hostname !== "api.github.com") return undefined;
    for (const data of repos) {
      const { repo } = data;
      if (url.pathname === `/repositories/${repo.id}`) return json(repo);
      const base = `/repos/${repo.owner.login}/${repo.name}`;
      if (url.pathname === base) return json(repo);
      if (url.pathname === `${base}/commits`) {
        if (data.emptyBranch) return json({ message: "Git Repository is empty." }, 409);
        const since = url.searchParams.get("since");
        const until = url.searchParams.get("until");
        const per = Number(url.searchParams.get("per_page") ?? "30");
        const page = Number(url.searchParams.get("page") ?? "1");
        const rows = (data.commits ?? [])
          .filter((c) => (!since || c.date >= since) && (!until || c.date < until))
          .sort((a, b) => (a.date < b.date ? 1 : -1))
          .slice((page - 1) * per, page * per)
          .map((c) => ({
            commit: { author: { name: c.name ?? "dev", email: c.email ?? null, date: c.date }, committer: { date: c.date } },
            author: c.authorId === undefined ? null : { id: c.authorId, login: c.login ?? `u${c.authorId}`, type: c.type ?? "User" },
          }));
        return json(rows);
      }
      if (url.pathname === `${base}/releases`) {
        const per = Number(url.searchParams.get("per_page") ?? "30");
        const page = Number(url.searchParams.get("page") ?? "1");
        const rows = (data.releases ?? []).map((r) => ({ created_at: r.published_at, ...r }));
        return json(rows.slice((page - 1) * per, page * per));
      }
      if (url.pathname === `${base}/readme`) {
        return data.readme == null ? json({ message: "Not Found" }, 404) : new Response(data.readme, { status: 200 });
      }
      if (url.pathname === `${base}/contents/`) return json(data.files ?? []);
      if (url.pathname === `${base}/languages`) return json(data.languages ?? {});
    }
    return undefined;
  };
}

/** OpenAI Chat Completions 응답을 흉내 낸다. */
export function fakeOpenAI(respond: (model: string, body: unknown) => Response | unknown): FakeRoute {
  return (url, init) => {
    if (url.hostname !== "api.openai.com") return undefined;
    const body = JSON.parse(String(init?.body ?? "{}")) as { model: string };
    const out = respond(body.model, body);
    if (out instanceof Response) return out;
    return json({ choices: [{ message: { content: JSON.stringify(out) } }] });
  };
}

export const goodClassification = {
  role: "explore",
  tags: ["search"],
  evidence: ["README에 전문 검색 기능이 설명되어 있다"],
  confidence: 0.9,
  cardName: "검색 드론",
  concept: "작은 프로펠러로 문서 더미를 훑는 드론",
};
