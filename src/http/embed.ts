const AVATAR_HOSTS = new Set(["avatars.githubusercontent.com", "github.com"]);
const cache = new Map<string, { exp: number; uri: string | null }>();
const TTL_MS = 10 * 60_000;

function sniffMime(bytes: Buffer): string | null {
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return "image/jpeg";
  if (bytes.subarray(1, 4).toString("ascii") === "PNG") return "image/png";
  if (bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP") {
    return "image/webp";
  }
  if (bytes.subarray(0, 6).toString("ascii") === "GIF87a" || bytes.subarray(0, 6).toString("ascii") === "GIF89a") {
    return "image/gif";
  }
  return null;
}

/** GitHub 프로필 사진을 data URI로 넣는다. README의 SVG는 외부 그림을 불러오지 못한다. */
export async function avatarDataUri(url: string | null | undefined): Promise<string | null> {
  if (!url || process.env.NODE_ENV === "test") return null;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:" || !AVATAR_HOSTS.has(parsed.hostname)) return null;
  parsed.searchParams.set("s", "96");
  const key = parsed.href;
  const hit = cache.get(key);
  if (hit && hit.exp > Date.now()) return hit.uri;
  let uri: string | null = null;
  try {
    const res = await fetch(key, {
      headers: { Accept: "image/*", "User-Agent": "repo-tcg-badge" },
      signal: AbortSignal.timeout(2500),
      redirect: "follow",
    });
    if (res.ok) {
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length > 0 && buf.length < 120_000) {
        const mime = sniffMime(buf) ?? res.headers.get("content-type")?.split(";")[0]?.trim();
        if (mime?.startsWith("image/")) uri = `data:${mime};base64,${buf.toString("base64")}`;
      }
    }
  } catch {
    uri = null;
  }
  cache.set(key, { exp: Date.now() + TTL_MS, uri });
  return uri;
}

/** 카드 일러스트를 README에 넣을 크기로 줄인다. */
export async function cardArtDataUri(bytes: Buffer | null | undefined): Promise<string | null> {
  if (!bytes?.length) return null;
  try {
    const sharp = (await import("sharp")).default;
    const out = await sharp(bytes).resize(200, 150, { fit: "cover" }).jpeg({ quality: 68 }).toBuffer();
    return `data:image/jpeg;base64,${out.toString("base64")}`;
  } catch {
    if (bytes.length <= 36_000) {
      const mime = sniffMime(bytes);
      return mime ? `data:${mime};base64,${bytes.toString("base64")}` : null;
    }
    return null;
  }
}
