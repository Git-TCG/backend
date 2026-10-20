import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import subsetFont from "subset-font";

const dir = fileURLToPath(new URL("../../content/fonts/", import.meta.url));
const cache = new Map<string, string>();
let sources: { card: Buffer; ui: Buffer } | null | undefined;

async function load(): Promise<{ card: Buffer; ui: Buffer } | null> {
  if (sources !== undefined) return sources;
  try {
    const [card, ui] = await Promise.all([
      readFile(`${dir}card-custom.woff2`),
      readFile(`${dir}pretendard-bold.woff2`),
    ]);
    sources = { card, ui };
  } catch {
    sources = null;
  }
  return sources;
}

function uniqueText(text: string): string {
  return [...new Set(text.replace(/\s+/g, ""))].sort().join("");
}

async function face(name: string, src: Buffer, text: string): Promise<string> {
  const subset = await subsetFont(src, text, { targetFormat: "woff2" });
  return `@font-face{font-family:${name};src:url(data:font/woff2;base64,${subset.toString("base64")}) format("woff2");font-weight:700;font-display:swap}`;
}

/** README SVG는 외부 글꼴을 못 불러서, 이 그림에 쓰는 글자만 넣어 둔다. */
export async function badgeFontCss(text: string): Promise<string> {
  const chars = uniqueText(`${text}0`) || "0";
  const hit = cache.get(chars);
  if (hit) return hit;
  const fonts = await load();
  if (!fonts) return "";
  try {
    const css = `${await face("CardCustom", fonts.card, chars)}${await face("Pretendard", fonts.ui, chars)}`;
    cache.set(chars, css);
    return css;
  } catch {
    return "";
  }
}
