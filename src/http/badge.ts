import { badgeFontCss } from "./fonts.js";
import { logoMark, SITE_HOST, SITE_URL } from "./logo.js";

const ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
export const xml = (value: unknown) => String(value ?? "").replace(/[&<>"']/g, (c) => ESCAPES[c]!);

export interface BadgeRow {
  label: string;
  value: string;
}

export interface BadgeMiniCard {
  name: string;
  grade: string;
  role: string;
  cost: number;
  attack?: number;
  durability?: number;
  ability?: string | null;
  abilityText?: string | null;
  art?: string | null;
}

const UI = "Pretendard, 'Apple SD Gothic Neo', Malgun Gothic, sans-serif";
const CARD = "CardCustom, Pretendard, Palatino, serif";
const ROLE_TONE: Record<string, { a: string; b: string }> = {
  attack: { a: "#a8231b", b: "#e8833a" },
  defense: { a: "#234c74", b: "#9dbad3" },
  support: { a: "#23704a", b: "#d1b04a" },
  control: { a: "#4b2d7a", b: "#2a9d8f" },
  explore: { a: "#b9850f", b: "#4aa3df" },
};
const ROLE_LABEL: Record<string, string> = {
  attack: "공격",
  defense: "방어",
  support: "지원",
  control: "제어",
  explore: "탐색",
};
const ABILITY_NAME: Record<string, string> = {
  rush: "즉시 공격",
  strike: "타격",
  ping: "코어 공격",
  scout: "탐색",
  draw: "드로우",
  fortify: "코어 회복",
  freeze: "빙결",
  weaken: "약화",
  repair: "수리",
  overclock: "오버클럭",
  inspire: "응원",
  shield: "방어막",
  backup: "백업",
  explode: "폭발",
};
const GRADE_STARS: Record<string, number> = { C: 1, B: 2, A: 3, S: 4, SS: 5 };
const GRADE_THEME: Record<string, { bar0: string; bar1: string; art: string; type: string; panel: string; border: string; ink: string }> = {
  C: { bar0: "#f3f0e8", bar1: "#ddd6c6", art: "#cfc6b0", type: "#ebe6da", panel: "#f4f1e8", border: "#c8bfaa", ink: "#1d2a2f" },
  B: { bar0: "#f3f7fa", bar1: "#d5dee6", art: "#b7c6d0", type: "#e4edf3", panel: "#eef3f7", border: "#8aa0ad", ink: "#1d2a2f" },
  A: { bar0: "#fff6d8", bar1: "#e4c56a", art: "#d4b056", type: "#f3e3b3", panel: "#f6ead0", border: "#c9a14a", ink: "#1d2a2f" },
  S: { bar0: "#3d3424", bar1: "#1c1812", art: "#f0d27a", type: "#2a2418", panel: "#1e2430", border: "#e0c36a", ink: "#f4ead0" },
  SS: { bar0: "#fff4c4", bar1: "#c99220", art: "#f2c94c", type: "#ffe9a0", panel: "#fff3cc", border: "#c99220", ink: "#2a1d08" },
};

async function wrap(width: number, height: number, title: string, body: string): Promise<string> {
  const css = await badgeFontCss(`${title}${body}${SITE_HOST}${SITE_URL}Repo TCG`);
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="${xml(title)}">
  <defs>
    <style>${css}</style>
    <linearGradient id="frame" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#8a6a2a"/>
      <stop offset="0.35" stop-color="#f1d48a"/>
      <stop offset="0.7" stop-color="#c9a227"/>
      <stop offset="1" stop-color="#6e5318"/>
    </linearGradient>
    <linearGradient id="leather" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#2a1c12"/>
      <stop offset="1" stop-color="#120c08"/>
    </linearGradient>
  </defs>
  <rect width="${width}" height="${height}" rx="18" fill="url(#frame)"/>
  <rect x="4" y="4" width="${width - 8}" height="${height - 8}" rx="14" fill="url(#leather)"/>
  <g font-family="${UI}">
  ${body}
  </g>
</svg>`;
}

function footer(width: number, y: number): string {
  return `${logoMark(10, y, 16, "dark", "ft")}
    <text x="30" y="${y + 12}" fill="#cbb98a" font-size="9">${xml(SITE_HOST)}</text>
    <text x="${width - 12}" y="${y + 12}" fill="#8a7a58" font-size="8" text-anchor="end">${xml(SITE_URL)}</text>`;
}

function wrapLines(text: string, maxChars: number): string[] {
  const s = String(text ?? "").trim();
  if (!s) return [];
  const width = Math.max(4, maxChars);
  const lines: string[] = [];
  let i = 0;
  while (i < s.length) {
    lines.push(s.slice(i, i + width));
    i += width;
  }
  return lines;
}

function cardLayout(w: number, card: BadgeMiniCard | null) {
  const p = 5;
  const innerW = w - p * 2;
  const nameChars = Math.max(6, Math.floor((innerW - 26) / 9));
  const textChars = Math.max(8, Math.floor((innerW - 10) / 8));
  const nameLines = card ? wrapLines(card.name, nameChars) : [];
  const abilityName = card?.ability ? ABILITY_NAME[card.ability] ?? card.ability : null;
  const abilityLines = card ? wrapLines(card.abilityText ?? "능력 없음", textChars) : [];
  const headH = Math.max(18, nameLines.length * 12 + 6);
  const artH = Math.round(innerW * 0.75);
  const typeH = 14;
  const statsH = 16;
  const textH = 8 + (abilityName ? 12 : 0) + abilityLines.length * 10;
  const h = p + headH + 4 + artH + 3 + typeH + 3 + textH + 3 + statsH + p;
  return { p, innerW, nameLines, abilityName, abilityLines, headH, artH, typeH, statsH, textH, h };
}

function miniCard(x: number, y: number, w: number, h: number, card: BadgeMiniCard | null, slot: number): string {
  const id = `c${slot}`;
  if (!card) {
    return `<g>
      <rect x="${x}" y="${y}" width="${w}" height="${h}" rx="10" fill="#1b140e" stroke="#6e5318"/>
      <text x="${x + w / 2}" y="${y + h / 2}" fill="#6e5318" font-size="11" font-family="${CARD}" text-anchor="middle">빈 칸</text>
    </g>`;
  }
  const role = ROLE_TONE[card.role] ?? { a: "#6b7f86", b: "#b7c4c8" };
  const theme = GRADE_THEME[card.grade] ?? GRADE_THEME.C!;
  const { p, innerW, nameLines, abilityName, abilityLines, headH, artH, typeH, statsH, textH } = cardLayout(w, card);
  const innerX = x + p;
  const artY = y + p + headH + 4;
  const typeY = artY + artH + 3;
  const textY = typeY + typeH + 3;
  const statsY = y + h - p - statsH;
  const textBoxH = Math.max(textH, statsY - 3 - textY);
  const stars = "★".repeat(GRADE_STARS[card.grade] ?? 1);
  const art = card.art
    ? `<image href="${xml(card.art)}" x="${innerX + 3}" y="${artY + 3}" width="${innerW - 6}" height="${artH - 6}" preserveAspectRatio="xMidYMid slice" clip-path="url(#${id}a)"/>`
    : `<text x="${x + w / 2}" y="${artY + artH / 2 + 6}" fill="#fff" fill-opacity="0.85" font-size="${Math.round(artH * 0.45)}" font-family="${CARD}" font-weight="700" text-anchor="middle">${xml([...card.name][0] ?? "?")}</text>`;
  const names = nameLines
    .map((line, i) => `<text x="${innerX + 6}" y="${y + p + 12 + i * 12}" fill="${theme.ink}" font-size="10">${xml(line)}</text>`)
    .join("");
  const body = [
    abilityName ? `<text x="${innerX + 5}" y="${textY + 12}" fill="${theme.ink}" font-size="8">${xml(abilityName)}</text>` : "",
    ...abilityLines.map(
      (line, i) =>
        `<text x="${innerX + 5}" y="${textY + (abilityName ? 22 : 12) + i * 10}" fill="${theme.ink}" font-size="7">${xml(line)}</text>`,
    ),
  ].join("");
  return `<g font-family="${CARD}" font-weight="700">
    <defs>
      <linearGradient id="${id}f" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" stop-color="${role.a}"/><stop offset="1" stop-color="${role.b}"/>
      </linearGradient>
      <linearGradient id="${id}n" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="${theme.bar0}"/><stop offset="1" stop-color="${theme.bar1}"/>
      </linearGradient>
      <clipPath id="${id}a"><rect x="${innerX + 3}" y="${artY + 3}" width="${innerW - 6}" height="${artH - 6}" rx="3"/></clipPath>
    </defs>
    <rect x="${x}" y="${y}" width="${w}" height="${h}" rx="10" fill="url(#${id}f)" stroke="rgba(0,0,0,0.35)" stroke-width="2"/>
    <rect x="${innerX}" y="${y + p}" width="${innerW}" height="${headH}" rx="5" fill="url(#${id}n)" stroke="${theme.border}"/>
    ${names}
    <circle cx="${x + w - p - 10}" cy="${y + p + headH / 2}" r="8" fill="#1b5fa8" stroke="#f4e3a1" stroke-width="1.4"/>
    <text x="${x + w - p - 10}" y="${y + p + headH / 2 + 4}" fill="#fff" font-size="9" text-anchor="middle">${xml(card.cost)}</text>
    <rect x="${innerX}" y="${artY}" width="${innerW}" height="${artH}" rx="4" fill="${role.b}" stroke="${theme.art}" stroke-width="3"/>
    ${art}
    <rect x="${innerX + innerW - 40}" y="${artY + artH - 16}" width="36" height="12" rx="6" fill="rgba(0,0,0,0.55)"/>
    <text x="${innerX + innerW - 22}" y="${artY + artH - 7}" fill="#ffd84a" font-size="8" text-anchor="middle">${xml(stars)} ${xml(card.grade)}</text>
    <rect x="${innerX}" y="${typeY}" width="${innerW}" height="${typeH}" rx="3" fill="${theme.type}"/>
    <text x="${innerX + 5}" y="${typeY + 11}" fill="${theme.ink}" font-size="8">【${xml(ROLE_LABEL[card.role] ?? card.role)} · ${xml(card.grade)}등급】</text>
    <rect x="${innerX}" y="${textY}" width="${innerW}" height="${textBoxH}" rx="3" fill="${theme.panel}" stroke="${theme.border}"/>
    ${body}
    <rect x="${innerX}" y="${statsY}" width="${innerW}" height="${statsH}" rx="3" fill="rgba(255,255,255,0.82)"/>
    <text x="${innerX + 6}" y="${statsY + 12}" fill="#a3241b" font-size="9">ATK ${xml(card.attack ?? "-")}</text>
    <text x="${innerX + innerW - 6}" y="${statsY + 12}" fill="#1f4f80" font-size="9" text-anchor="end">DEF ${xml(card.durability ?? "-")}</text>
  </g>`;
}

/** GitHub README에 붙이는 상태/전적 카드. */
export async function statsCardSvg(opts: {
  title: string;
  subtitle?: string;
  rows: BadgeRow[];
  accent?: string;
  ok?: boolean;
}): Promise<string> {
  const width = 400;
  const rows = opts.rows.slice(0, 5);
  const height = 160 + rows.length * 26;
  const accent = opts.ok === false ? "#c0392b" : "#3d9b8f";
  const start = 78;
  const body = rows
    .map((row, i) => {
      const y = start + i * 26;
      return `<rect x="16" y="${y - 15}" width="${width - 32}" height="22" rx="6" fill="#f7eed8" fill-opacity="0.08"/>
        <text x="28" y="${y}" fill="#cbb98a" font-size="12">${xml(row.label)}</text>
        <text x="${width - 28}" y="${y}" fill="#f7eed8" font-size="13" font-weight="700" text-anchor="end">${xml(row.value)}</text>`;
    })
    .join("");
  return wrap(
    width,
    height,
    opts.title,
    `${logoMark(14, 12, 36, "dark", "lg")}
     <text x="58" y="30" fill="#f1d48a" font-size="16" font-weight="700">${xml(opts.title)}</text>
     <text x="58" y="48" fill="${accent}" font-size="11">${xml(opts.subtitle ?? "")}</text>
     ${body}
     ${footer(width, height - 34)}`,
  );
}

export async function userBadgeSvg(opts: {
  login: string;
  name?: string | null;
  avatar?: string | null;
  rows: BadgeRow[];
  cards: BadgeMiniCard[];
  ok?: boolean;
}): Promise<string> {
  const M = 12;
  const FOOT = 18;
  const BOTTOM = 14;
  const leftW = 236;
  const cardW = 158;
  const gap = 8;
  const cardsX = M + leftW + 10;
  const cardH = Math.max(248, ...[0, 1, 2].map((i) => cardLayout(cardW, opts.cards[i] ?? null).h));
  const width = cardsX + 3 * cardW + 2 * gap + M;
  const height = M + cardH + 6 + FOOT + BOTTOM;
  const display = opts.name?.trim() || opts.login;
  const accent = opts.ok === false ? "#c0392b" : "#f1d48a";
  const nameLines = wrapLines(display, 16);
  const avatar = opts.avatar
    ? `<defs><clipPath id="av"><rect x="${M}" y="${M}" width="48" height="48" rx="10"/></clipPath></defs>
       <image href="${xml(opts.avatar)}" x="${M}" y="${M}" width="48" height="48" preserveAspectRatio="xMidYMid slice" clip-path="url(#av)"/>`
    : `<rect x="${M}" y="${M}" width="48" height="48" rx="10" fill="#3d9b8f"/>
       <text x="${M + 24}" y="${M + 32}" fill="#f7eed8" font-size="18" font-weight="700" text-anchor="middle">${xml((opts.login[0] ?? "?").toUpperCase())}</text>`;
  const title = nameLines
    .map((line, i) => `<text x="${M + 56}" y="${M + 20 + i * 16}" fill="${accent}" font-size="15" font-weight="700">${xml(line)}</text>`)
    .join("");
  const stats = opts.rows
    .slice(0, 4)
    .map((row, i) => {
      const y = M + 72 + i * 36;
      return `<text x="${M}" y="${y}" fill="#8a7a58" font-size="11">${xml(row.label)}</text>
        <text x="${M}" y="${y + 16}" fill="#f7eed8" font-size="16" font-weight="700">${xml(row.value)}</text>`;
    })
    .join("");
  const slots = [0, 1, 2].map((i) => miniCard(cardsX + i * (cardW + gap), M, cardW, cardH, opts.cards[i] ?? null, i));
  return wrap(
    width,
    height,
    display,
    `${avatar}
     ${title}
     <text x="${M + 56}" y="${M + 22 + nameLines.length * 16}" fill="#cbb98a" font-size="11">@${xml(opts.login)}</text>
     <line x1="${M + leftW + 5}" y1="${M}" x2="${M + leftW + 5}" y2="${M + cardH}" stroke="#6e5318" stroke-opacity="0.65"/>
     ${stats}
     ${slots.join("")}
     ${footer(width, M + cardH + 6)}`,
  );
}

export function sendSvg(
  reply: { header: (k: string, v: string) => unknown; code: (n: number) => { send: (b: string) => unknown } },
  status: number,
  svg: string,
  cacheSeconds: number,
) {
  reply.header("Content-Type", "image/svg+xml; charset=utf-8");
  reply.header("Cache-Control", `public, max-age=${cacheSeconds}, s-maxage=${cacheSeconds}`);
  reply.header("Access-Control-Allow-Origin", "*");
  return reply.code(status).send(svg);
}
