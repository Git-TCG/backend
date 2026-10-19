import { z } from "zod";

const optionalSecret = z
  .string()
  .optional()
  .transform((v) => (v ? v : undefined));

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  HOST: z.string().default("0.0.0.0"),
  PORT: z.coerce.number().int().positive().default(3000),
  PUBLIC_URL: z.url().default("https://api-tcg.shxin.kr"),
  CORS_ORIGINS: z
    .string()
    .default("")
    .transform((v) =>
      v
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
    ),
  DATABASE_URL: z.string().min(1),

  // 4단계(로그인·수집)와 5단계(카드 생성 워커)부터 필수가 된다.
  GITHUB_CLIENT_ID: optionalSecret,
  GITHUB_CLIENT_SECRET: optionalSecret,
  GITHUB_CLASSIC_TOKEN: optionalSecret,
  OPENAI_API_KEY: optionalSecret,
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
