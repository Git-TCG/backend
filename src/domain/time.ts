/** 일일 보상·동기화 기준 시간대. 사용자 대부분이 한국에 있다. */
export const SERVICE_TIME_ZONE = "Asia/Seoul";

/** 서비스 기준 날짜(YYYY-MM-DD). */
export function serviceDay(at: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: SERVICE_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(at);
}
