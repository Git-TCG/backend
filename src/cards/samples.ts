import type { CardDef } from "../engine/types.js";
import { buildCardDefinition, type BuildCardInput } from "./build.js";

/** 1단계 전투 검증용 샘플 카드 20장. 실제 Repo가 아니라 가상의 프로젝트이다. */
const SAMPLE_INPUTS: BuildCardInput[] = [
  { id: "sample-01", name: "검색 드론", grade: "C", role: "explore", tags: ["search"] },
  { id: "sample-02", name: "작업 로봇", grade: "B", role: "attack", tags: ["automation"], effect: "rush" },
  { id: "sample-03", name: "방화벽", grade: "C", role: "defense", tags: ["security"] },
  { id: "sample-04", name: "기록 보관소", grade: "B", role: "support", tags: ["storage"] },
  { id: "sample-05", name: "도트 아레나", grade: "C", role: "attack", tags: ["game"] },
  { id: "sample-06", name: "배치 스케줄러", grade: "C", role: "support", tags: ["automation"] },
  { id: "sample-07", name: "패킷 스니퍼", grade: "C", role: "control", tags: ["network"] },
  { id: "sample-08", name: "린트 봇", grade: "C", role: "defense", tags: ["devtool"] },
  { id: "sample-09", name: "문서 생성기", grade: "B", role: "explore", tags: ["generation"] },
  { id: "sample-10", name: "로드 밸런서", grade: "B", role: "control", tags: ["network"], effect: "freeze" },
  { id: "sample-11", name: "디자인 시스템", grade: "B", role: "support", tags: ["ui"] },
  { id: "sample-12", name: "웹훅 릴레이", grade: "B", role: "attack", tags: ["network"], effect: "ping" },
  { id: "sample-13", name: "백업 금고", grade: "A", role: "defense", tags: ["storage"], effect: "backup" },
  { id: "sample-14", name: "데이터 정제기", grade: "A", role: "control", tags: ["data"] },
  { id: "sample-15", name: "크롤러 군단", grade: "A", role: "attack", tags: ["search", "network"] },
  { id: "sample-16", name: "CI 파이프라인", grade: "A", role: "support", tags: ["automation", "devtool"], effect: "fortify" },
  { id: "sample-17", name: "벡터 인덱스", grade: "S", role: "explore", tags: ["search", "data"], effect: "draw" },
  { id: "sample-18", name: "제로트러스트 게이트", grade: "S", role: "defense", tags: ["security"] },
  { id: "sample-19", name: "자폭 테스트베드", grade: "S", role: "defense", tags: [], effect: "explode" },
  { id: "sample-20", name: "멀티 에이전트 런타임", grade: "SS", role: "attack", tags: ["generation", "network"], effect: "strike" },
];

export const SAMPLE_CARDS: Record<string, CardDef> = Object.fromEntries(
  SAMPLE_INPUTS.map((input) => [input.id, buildCardDefinition(input)]),
);

/** 비용 곡선을 고려한 체험 덱 두 벌. */
export const SAMPLE_DECKS: [string[], string[]] = [
  ["sample-01", "sample-02", "sample-03", "sample-04", "sample-12", "sample-14", "sample-18"],
  ["sample-05", "sample-06", "sample-07", "sample-09", "sample-11", "sample-13", "sample-17"],
];
