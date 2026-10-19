import { createHash } from "node:crypto";
import { GitHubError, type GitHubClient } from "./client.js";
import type { GithubRepo } from "./repos.js";

/** 분류 입력 형식이 바뀌면 올린다. 해시가 달라져 다시 분석된다. */
export const CLASSIFIER_INPUT_VERSION = "input-v1";
const README_LIMIT = 6000;
const ROOT_FILE_LIMIT = 60;

/** AI 분류에 넘기는 제한된 입력(4장): README·토픽·파일 구조·언어. */
export interface ClassificationInput {
  fullName: string;
  description: string | null;
  topics: string[];
  languages: string[];
  rootFiles: string[];
  readme: string;
}

const repoPath = (repo: GithubRepo) =>
  `/repos/${encodeURIComponent(repo.owner.login)}/${encodeURIComponent(repo.name)}`;

/** 없거나(404) 비어 있는(409) 내용은 빈 값으로 본다. */
async function optional<T>(load: () => Promise<T | null>, empty: T): Promise<T> {
  try {
    return (await load()) ?? empty;
  } catch (err) {
    if (err instanceof GitHubError && (err.status === 404 || err.status === 409)) return empty;
    throw err;
  }
}

export async function loadClassificationInput(github: GitHubClient, repo: GithubRepo): Promise<ClassificationInput> {
  const path = repoPath(repo);
  const [readme, contents, languages] = await Promise.all([
    optional(() => github.request<string>(`${path}/readme`, { accept: "application/vnd.github.raw+json", allowNotFound: true }), ""),
    optional(() => github.request<{ name: string; type: string }[]>(`${path}/contents/`, { allowNotFound: true }), []),
    optional(() => github.request<Record<string, number>>(`${path}/languages`, { allowNotFound: true }), {}),
  ]);
  return {
    fullName: repo.full_name,
    description: repo.description,
    topics: [...(repo.topics ?? [])].sort(),
    languages: Object.entries(languages)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([name]) => name),
    rootFiles: (Array.isArray(contents) ? contents : [])
      .map((f) => (f.type === "dir" ? `${f.name}/` : f.name))
      .sort()
      .slice(0, ROOT_FILE_LIMIT),
    readme: readme.slice(0, README_LIMIT),
  };
}

export function classificationInputHash(input: ClassificationInput): string {
  return createHash("sha256")
    .update(JSON.stringify({ version: CLASSIFIER_INPUT_VERSION, ...input }))
    .digest("hex");
}
