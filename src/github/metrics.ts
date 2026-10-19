import type { RepoMetrics } from "../cards/grade.js";
import { GitHubError, type GitHubClient } from "./client.js";
import type { GithubRepo } from "./repos.js";

/** 협업 점수는 기여자 10명에서 만점이므로 그 이상은 셀 필요가 없다. */
const CONTRIBUTOR_CAP = 10;
const MAX_COMMIT_PAGES = 30;
const MAX_RELEASE_PAGES = 10;

/**
 * 기여자 식별 규칙(grade-v0.1):
 * - GitHub 계정과 연결된 작성자는 계정 ID로 센다. 계정 type이 Bot이거나 로그인이 [bot]으로 끝나면 제외한다.
 * - 연결되지 않은 작성자는 소문자 이메일로 센다. 이름이 [bot]으로 끝나거나 이메일이 없으면 제외한다.
 */
export const CONTRIBUTOR_RULE = "account-id-else-email;exclude-bots";

export interface MetricsWindow {
  since: Date;
  until: Date;
  /** YYYY-MM 12개 */
  months: string[];
}

/** 직전에 완료된 12개월. 기준 시각이 속한 달은 포함하지 않는다(UTC). */
export function lastTwelveMonths(now: Date = new Date()): MetricsWindow {
  const until = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const since = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 12, 1));
  const months: string[] = [];
  for (let i = 0; i < 12; i++) {
    const d = new Date(Date.UTC(since.getUTCFullYear(), since.getUTCMonth() + i, 1));
    months.push(d.toISOString().slice(0, 7));
  }
  return { since, until, months };
}

interface CommitRow {
  commit?: { author?: { name?: string; email?: string; date?: string }; committer?: { date?: string } };
  author?: { id?: number; login?: string; type?: string } | null;
}

export function contributorKey(row: CommitRow): string | null {
  const account = row.author;
  if (account && typeof account.id === "number") {
    if (account.type === "Bot" || /\[bot\]$/i.test(account.login ?? "")) return null;
    return `id:${account.id}`;
  }
  const name = row.commit?.author?.name ?? "";
  const email = row.commit?.author?.email?.trim().toLowerCase();
  if (!email || /\[bot\]$/i.test(name) || /\[bot\]@/i.test(email)) return null;
  return `email:${email}`;
}

const repoPath = (repo: GithubRepo) =>
  `/repos/${encodeURIComponent(repo.owner.login)}/${encodeURIComponent(repo.name)}`;

/** 기본 브랜치가 비어 있으면 GitHub는 409를 돌려준다. 커밋이 없는 것으로 본다. */
async function commitsPage(github: GitHubClient, path: string): Promise<CommitRow[]> {
  try {
    const rows = await github.request<CommitRow[]>(path);
    if (!Array.isArray(rows)) throw new Error("커밋 응답이 배열이 아닙니다");
    return rows;
  } catch (err) {
    if (err instanceof GitHubError && err.status === 409) return [];
    throw err;
  }
}

export interface CollectedMetrics extends RepoMetrics {
  window: { since: string; until: string };
  /** 페이지 상한 때문에 기여자 수가 하한값일 수 있으면 true. */
  contributorsLowerBound: boolean;
  requests: number;
}

/**
 * 5장 등급 지표를 모은다. Stars·Forks는 Repo 응답 값을 그대로 쓴다.
 * 커밋은 최신순으로 읽다가 기여자가 상한에 닿으면 멈추고, 아직 확인하지 못한 달은 달마다 1건 조회로 확인한다.
 */
export async function collectMetrics(github: GitHubClient, repo: GithubRepo, now = new Date()): Promise<CollectedMetrics> {
  const window = lastTwelveMonths(now);
  const base = `${repoPath(repo)}/commits?sha=${encodeURIComponent(repo.default_branch)}`;
  const range = (since: Date, until: Date) =>
    `&since=${encodeURIComponent(since.toISOString())}&until=${encodeURIComponent(until.toISOString())}`;
  let requests = 0;

  const activeMonths = new Set<string>();
  const people = new Set<string>();
  let complete = false;
  for (let page = 1; page <= MAX_COMMIT_PAGES; page++) {
    const rows = await commitsPage(github, `${base}${range(window.since, window.until)}&per_page=100&page=${page}`);
    requests++;
    for (const row of rows) {
      const date = row.commit?.committer?.date ?? row.commit?.author?.date;
      if (date) activeMonths.add(date.slice(0, 7));
      const key = contributorKey(row);
      if (key) people.add(key);
    }
    if (rows.length < 100) {
      complete = true;
      break;
    }
    if (people.size >= CONTRIBUTOR_CAP) break;
  }

  if (!complete) {
    // 끝까지 읽지 않았으므로 보지 못한 달은 달마다 커밋 존재 여부를 직접 확인한다.
    for (const month of window.months) {
      if (activeMonths.has(month)) continue;
      const start = new Date(`${month}-01T00:00:00Z`);
      const end = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 1));
      const rows = await commitsPage(github, `${base}${range(start, end)}&per_page=1`);
      requests++;
      if (rows.length > 0) activeMonths.add(month);
    }
  }

  const releaseMonths = new Set<string>();
  for (let page = 1; page <= MAX_RELEASE_PAGES; page++) {
    const rows = await github.request<
      { draft?: boolean; prerelease?: boolean; published_at?: string | null; created_at?: string }[]
    >(`${repoPath(repo)}/releases?per_page=100&page=${page}`);
    requests++;
    if (!Array.isArray(rows)) throw new Error("릴리스 응답이 배열이 아닙니다");
    for (const r of rows) {
      if (r.draft || r.prerelease || !r.published_at) continue;
      const at = new Date(r.published_at);
      if (at >= window.since && at < window.until) releaseMonths.add(r.published_at.slice(0, 7));
    }
    // 목록은 생성일 최신순이다. 이 페이지에 기간 이전에 만든 릴리스가 있으면 더 오래된 페이지는 볼 필요가 없다.
    const reachedOlder = rows.some((r) => r.created_at && new Date(r.created_at) < window.since);
    if (rows.length < 100 || reachedOlder) break;
  }

  const count = (n: unknown) => (Number.isInteger(n) && (n as number) >= 0 ? (n as number) : null);
  return {
    stars: count(repo.stargazers_count),
    forks: count(repo.forks_count),
    activeMonths: [...activeMonths].filter((m) => window.months.includes(m)).length,
    contributors: people.size,
    releaseMonths: releaseMonths.size,
    window: { since: window.since.toISOString(), until: window.until.toISOString() },
    contributorsLowerBound: !complete && people.size < CONTRIBUTOR_CAP,
    requests,
  };
}
