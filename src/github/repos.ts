import type { GitHubClient } from "./client.js";

/** GitHub Repo 응답 중 이 서비스가 쓰는 필드. */
export interface GithubRepo {
  id: number;
  name: string;
  full_name: string;
  html_url: string;
  description: string | null;
  owner: { id: number; login: string; type: string };
  private: boolean;
  fork: boolean;
  archived: boolean;
  size: number;
  default_branch: string;
  stargazers_count: number;
  forks_count: number;
  topics?: string[];
  language?: string | null;
  pushed_at?: string | null;
}

const MAX_PAGES = 30;

/** 2장 초기 필터에서 제외하는 이유. 해당 없으면 null. */
export function exclusionReason(repo: GithubRepo, expectedOwnerId?: number): string | null {
  if (repo.private) return "비공개";
  if (expectedOwnerId !== undefined && repo.owner.id !== expectedOwnerId) return "다른 소유자";
  if (repo.fork) return "Fork";
  if (repo.size === 0) return "빈 Repo";
  const name = repo.name.toLowerCase();
  if (name === repo.owner.login.toLowerCase() || name === ".github") return "프로필 소개용 Repo";
  return null;
}

async function listAllPages(github: GitHubClient, basePath: string): Promise<GithubRepo[]> {
  const repos = new Map<number, GithubRepo>();
  for (let page = 1; page <= MAX_PAGES; page++) {
    const sep = basePath.includes("?") ? "&" : "?";
    const rows = await github.request<GithubRepo[]>(`${basePath}${sep}per_page=100&page=${page}`);
    if (!Array.isArray(rows)) throw new Error("GitHub Repo 목록 응답이 배열이 아닙니다");
    for (const r of rows) repos.set(r.id, r);
    if (rows.length < 100) return [...repos.values()];
  }
  throw new Error(`Repo가 ${MAX_PAGES * 100}개를 넘어 목록을 끝까지 읽지 못했습니다`);
}

/** 계정 ID로 현재 로그인 이름을 확인한다. 로그인 이름이 바뀌어도 같은 계정을 찾는다. */
export async function fetchLoginById(github: GitHubClient, userId: number): Promise<string> {
  const user = await github.request<{ id: number; login: string }>(`/user/${userId}`);
  if (user.id !== userId) throw new Error("GitHub 사용자 ID가 일치하지 않습니다");
  return user.login;
}

/** 본인 소유 공개 Repo 전체 중 카드 대상만 돌려준다. Archived는 포함한다. */
export async function listOwnedCardRepos(github: GitHubClient, userId: number): Promise<GithubRepo[]> {
  const login = await fetchLoginById(github, userId);
  const all = await listAllPages(github, `/users/${encodeURIComponent(login)}/repos?type=owner&sort=created`);
  return all.filter((r) => exclusionReason(r, userId) === null);
}

/** 조직의 공개 Repo 전체. 운영자 화면에서 제외 이유와 함께 보여 준다. */
export async function listOrgRepos(github: GitHubClient, org: string): Promise<GithubRepo[]> {
  return listAllPages(github, `/orgs/${encodeURIComponent(org)}/repos?type=public&sort=full_name`);
}

/** Repo ID로 조회한다. 이름 변경·이전 후에도 같은 Repo를 찾는다. 공개 접근이 안 되면 null. */
export async function fetchRepoById(github: GitHubClient, repoId: number): Promise<GithubRepo | null> {
  const repo = await github.request<GithubRepo>(`/repositories/${repoId}`, { allowNotFound: true });
  if (repo && repo.private) return null;
  return repo;
}

export async function fetchRepoByName(github: GitHubClient, owner: string, name: string): Promise<GithubRepo | null> {
  return github.request<GithubRepo>(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`, {
    allowNotFound: true,
  });
}

/** https://github.com/owner/repo 형식만 받는다. */
export function parseRepoUrl(input: string): { owner: string; name: string } | null {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.hostname !== "github.com" || url.search || url.hash) return null;
  const parts = url.pathname.replace(/\.git$/, "").split("/").filter(Boolean);
  if (parts.length !== 2) return null;
  const valid = /^[A-Za-z0-9_.-]+$/;
  if (!valid.test(parts[0]!) || !valid.test(parts[1]!)) return null;
  return { owner: parts[0]!, name: parts[1]! };
}
