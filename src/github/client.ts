import { RetryLaterError } from "../jobs/errors.js";

const API = "https://api.github.com";
const TIMEOUT_MS = 15_000;
const TRANSIENT = new Set([500, 502, 503, 504]);

export class GitHubError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export interface GitHubRequestOptions {
  accept?: string;
  /** 404를 예외 대신 null로 돌려준다. */
  allowNotFound?: boolean;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 응답 헤더에서 한도 초과를 읽어 다시 시도할 때까지의 시간을 구한다. 한도 초과가 아니면 null. */
export function rateLimitDelay(res: Response, now = Date.now()): number | null {
  if (res.status !== 403 && res.status !== 429) return null;
  const retryAfter = res.headers.get("retry-after");
  if (retryAfter && /^\d+$/.test(retryAfter)) return Number(retryAfter) * 1000;
  if (res.headers.get("x-ratelimit-remaining") === "0") {
    const reset = Number(res.headers.get("x-ratelimit-reset"));
    if (Number.isFinite(reset) && reset > 0) return Math.max(1000, reset * 1000 - now + 1000);
  }
  return res.status === 429 ? 60_000 : null;
}

/** 공개 데이터 조회용 GitHub REST 클라이언트. */
export class GitHubClient {
  constructor(private readonly token: string | undefined) {}

  async request<T>(path: string, options: GitHubRequestOptions & { allowNotFound: true }): Promise<T | null>;
  async request<T>(path: string, options?: GitHubRequestOptions): Promise<T>;
  async request<T>(path: string, options: GitHubRequestOptions = {}): Promise<T | null> {
    if (!this.token) throw new Error("GITHUB_CLASSIC_TOKEN이 설정되지 않았습니다");
    const headers = {
      Authorization: `Bearer ${this.token}`,
      Accept: options.accept ?? "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "repo-tcg",
    };
    for (let attempt = 1; ; attempt++) {
      let res: Response;
      try {
        res = await fetch(`${API}${path}`, { headers, signal: AbortSignal.timeout(TIMEOUT_MS) });
      } catch (err) {
        if (attempt >= 3) throw new RetryLaterError(`GitHub 연결 실패: ${(err as Error).message}`, 60_000);
        await sleep(500 * attempt);
        continue;
      }
      const limited = rateLimitDelay(res);
      if (limited !== null) throw new RetryLaterError(`GitHub API 한도 초과 (${path})`, limited);
      if (TRANSIENT.has(res.status) && attempt < 3) {
        await sleep(500 * attempt);
        continue;
      }
      if (res.status === 404 && options.allowNotFound) return null;
      if (!res.ok) throw new GitHubError(res.status, `GitHub HTTP ${res.status} (${path})`);
      if (options.accept?.includes("raw")) return (await res.text()) as T;
      return (await res.json()) as T;
    }
  }
}

/** OAuth 코드를 사용자 토큰으로 바꾼다. 토큰은 사용자 확인에만 쓰고 저장하지 않는다. */
export async function exchangeOAuthCode(
  clientId: string,
  clientSecret: string,
  code: string,
  redirectUri: string,
): Promise<string> {
  const res = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json", "User-Agent": "repo-tcg" },
    body: JSON.stringify({ client_id: clientId, client_secret: clientSecret, code, redirect_uri: redirectUri }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const body = (await res.json().catch(() => ({}))) as { access_token?: string; error?: string };
  if (!res.ok || !body.access_token) throw new GitHubError(res.status, `GitHub OAuth 교환 실패: ${body.error ?? res.status}`);
  return body.access_token;
}

export interface GitHubProfile {
  id: number;
  login: string;
  name: string | null;
  avatar_url: string | null;
}

export async function fetchOAuthProfile(userToken: string): Promise<GitHubProfile> {
  const res = await fetch(`${API}/user`, {
    headers: {
      Authorization: `Bearer ${userToken}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "repo-tcg",
    },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new GitHubError(res.status, `GitHub 사용자 조회 실패: ${res.status}`);
  const p = (await res.json()) as Partial<GitHubProfile>;
  if (!Number.isSafeInteger(p.id) || !p.id || typeof p.login !== "string" || !p.login) {
    throw new GitHubError(502, "GitHub 사용자 응답이 올바르지 않습니다");
  }
  return { id: p.id, login: p.login, name: p.name ?? null, avatar_url: p.avatar_url ?? null };
}
