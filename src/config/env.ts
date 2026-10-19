import { z } from "zod";

const optionalSecret = z
  .string()
  .optional()
  .transform((v) => (v ? v : undefined));

const commaList = z
  .string()
  .default("")
  .transform((v) =>
    v
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  HOST: z.string().default("0.0.0.0"),
  PORT: z.coerce.number().int().positive().default(3000),
  /**
   * 웹 화면 주소 목록. 전체 Origin(http://host:port)이나 호스트만 적는다.
   * 호스트만 적으면 http://<호스트>:WEB_PORT 로 해석한다.
   * OAuth Redirect URI는 <Origin>/api/auth/github 이다.
   */
  CORS_ORIGINS: commaList,
  WEB_PORT: z.coerce.number().int().positive().default(8123),
  DATABASE_URL: z.string().min(1),

  GITHUB_CLIENT_ID: optionalSecret,
  GITHUB_CLIENT_SECRET: optionalSecret,
  /** 공개 Repo 메타데이터 수집용 서버 토큰. 사용자 OAuth 토큰은 저장하지 않는다. */
  GITHUB_CLASSIC_TOKEN: optionalSecret,
  OPENAI_API_KEY: optionalSecret,
  /** 분류 모델. 쉼표로 여러 개를 적으면 앞의 모델을 쓸 수 없을 때 다음 모델을 쓴다. */
  OPENAI_MODEL: z.string().default("gpt-4.1-mini,gpt-5-mini,gpt-4o-mini"),
  /** 운영자 기능을 쓸 GitHub 숫자 사용자 ID 목록. */
  ADMIN_GITHUB_IDS: commaList.transform((ids, ctx) =>
    ids.map((id) => {
      const n = Number(id);
      if (!Number.isSafeInteger(n) || n <= 0) {
        ctx.addIssue({ code: "custom", message: `숫자 GitHub ID가 아닙니다: ${id}` });
      }
      return n;
    }),
  ),
});

export type Env = z.infer<typeof schema>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = schema.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`).join("\n");
    throw new Error(`환경변수 설정 오류:\n${issues}`);
  }
  return parsed.data;
}

/** CORS_ORIGINS를 정확한 Origin 목록으로 바꾼다. 해석할 수 없는 항목은 버린다. */
export function allowedOrigins(env: Pick<Env, "CORS_ORIGINS" | "WEB_PORT">): string[] {
  const origins = env.CORS_ORIGINS.flatMap((entry) => {
    const candidate = /^https?:\/\//i.test(entry) ? entry : `http://${entry}`;
    let url: URL;
    try {
      url = new URL(candidate);
    } catch {
      return [];
    }
    if (url.pathname !== "/" || url.search || url.hash || url.username || url.password) return [];
    if (!/^https?:\/\//i.test(entry) && !url.port) url.port = String(env.WEB_PORT);
    return [url.origin];
  });
  return [...new Set(origins)];
}
