import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GENERIC_CLASSIFICATION } from "../cards/taxonomy.js";
import type { ClassificationInput } from "../github/content.js";
import { fakeOpenAI, goodClassification } from "../test/fake-repo.js";
import { json, stubFetch } from "../test/github.js";
import { classifyRepository, resetWorkingModel } from "./classify.js";

const input: ClassificationInput = {
  fullName: "octo/search",
  description: "full text search engine",
  topics: ["search"],
  languages: ["TypeScript"],
  rootFiles: ["README.md", "src/"],
  readme: "# search\n문서를 검색한다",
};

const env = (model = "m1") => ({ OPENAI_API_KEY: "k", OPENAI_MODEL: model });

describe("AI 분류", () => {
  beforeEach(() => resetWorkingModel());
  afterEach(() => vi.unstubAllGlobals());

  it("키가 없으면 AI를 부르지 않고 범용 분류를 쓴다(실패 아님)", async () => {
    const { mock } = stubFetch();
    const result = await classifyRepository({ OPENAI_MODEL: "m1" }, input);
    expect(mock).not.toHaveBeenCalled();
    expect(result).toMatchObject({ classification: GENERIC_CLASSIFICATION, cardName: null, failed: false, model: null });
    expect(result.error).toContain("OPENAI_API_KEY");
  });

  it("정상 응답은 역할·특성·이름·콘셉트를 그대로 쓴다", async () => {
    stubFetch(fakeOpenAI(() => goodClassification));
    const result = await classifyRepository(env(), input);
    expect(result.failed).toBe(false);
    expect(result.model).toBe("m1");
    expect(result.classification).toMatchObject({ role: "explore", tags: ["search"], generic: false });
    expect(result.cardName).toBe("검색 드론");
    expect(result.concept).toBe(goodClassification.concept);
  });

  it("허용 목록 밖 역할이나 근거 없음·낮은 신뢰도는 범용으로 버린다(실패 아님)", async () => {
    for (const bad of [
      { ...goodClassification, role: "wizard" },
      { ...goodClassification, evidence: [] },
      { ...goodClassification, confidence: 0.3 },
    ]) {
      resetWorkingModel();
      const { calls } = stubFetch(fakeOpenAI(() => bad));
      const result = await classifyRepository(env(), input);
      expect(result.classification.generic).toBe(true);
      expect(result.failed).toBe(false);
      expect(result.cardName).toBeNull();
      expect(calls).toHaveLength(1);
      vi.unstubAllGlobals();
    }
  });

  it("카드 이름·콘셉트가 규칙을 어기면 그 둘만 버리고 분류는 쓴다", async () => {
    stubFetch(fakeOpenAI(() => ({ ...goodClassification, cardName: "http://evil.example" })));
    const result = await classifyRepository(env(), input);
    expect(result.classification.generic).toBe(false);
    expect(result.cardName).toBeNull();
    expect(result.concept).toBeNull();
  });

  it("401·429 같은 치명적 오류는 실패로 기록하고 다른 모델도 시도하지 않는다", async () => {
    const { calls } = stubFetch(fakeOpenAI(() => json({ error: { code: "invalid_api_key" } }, 401)));
    const result = await classifyRepository(env("m1,m2"), input);
    expect(result).toMatchObject({ classification: GENERIC_CLASSIFICATION, failed: true, model: null });
    expect(calls).toHaveLength(1);
  });

  it("모델이 없으면 다음 모델로 넘어가고, 성공한 모델을 이후에 바로 쓴다", async () => {
    const requested: string[] = [];
    stubFetch(
      fakeOpenAI((model) => {
        requested.push(model);
        return model === "m1" ? json({ error: { code: "model_not_found" } }, 404) : goodClassification;
      }),
    );
    const first = await classifyRepository(env("m1,m2"), input);
    expect(first.model).toBe("m2");
    expect(first.failed).toBe(false);
    expect(requested).toEqual(["m1", "m2"]);

    const second = await classifyRepository(env("m1,m2"), input);
    expect(second.model).toBe("m2");
    expect(requested).toEqual(["m1", "m2", "m2"]);
  });

  it("일시 오류는 같은 모델을 한 번 더 시도한 뒤 실패로 기록한다", async () => {
    const { calls } = stubFetch(fakeOpenAI(() => json({ error: { message: "boom" } }, 500)));
    const result = await classifyRepository(env(), input);
    expect(result.failed).toBe(true);
    expect(result.classification.generic).toBe(true);
    expect(calls).toHaveLength(2);
  });
});
