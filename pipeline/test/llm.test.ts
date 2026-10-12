// 4단계 시험 — 근거 문장 사실·검증(FR-LLM-02·07·08), OpenAI 호출(FR-LLM-06·10), 대화 Worker 설정이 llm.yaml 과 같은지
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { buildFacts, factsHash, isReview, validReason, weatherOf, type FactInput } from "../src/llm/facts.js";
import { callJson, costOf, emptyUsage, LlmError } from "../src/shared/openai.js";

const base: FactInput = {
  name: "가상공원",
  lat: 37.5,
  lng: 127,
  signguCd: "11110",
  signgu: "종로구",
  provinceCd: "11",
  date: "2026-10-17",
  rep: "timing_game",
  types: ["timing_game"],
  likelihood: "high",
  forecast: 45.4,
  usual: 72.2,
  popularity: 91.3,
  trend: 0.257,
  longTerm: -0.312,
};
const mid = { byProvince: { "11": "11B00000", "51": "11D10000" }, gangwonEast: { regId: "11D20000", sigungu: ["강릉시"] } };
const ctx = (o: Partial<Parameters<typeof buildFacts>[1]> = {}) => ({
  typeLabel: (t: string) => ({ timing_game: "눈치게임" })[t] ?? t,
  holidays: {},
  events: [],
  weather: { short: {}, mid: {} },
  mid,
  ...o,
});

describe("근거 문장 사실", () => {
  it("숫자는 반올림한 정수, 평소 대비 차이, 인기 상위 %", () => {
    const f = buildFacts(base, ctx());
    expect(f).toMatchObject({ dateLabel: "10월 17일(토)", weekend: true, main: "눈치게임", congestion: 45, usual: 72, belowUsual: 27, popularityTopPct: 9, searchGrowthPct: 26, interestChangePct: -31, likelihood: "높음" });
  });
  it("근처 10km 안·그날 열리는 행사만, 최대 2개", () => {
    const events = [
      { title: "가 축제", lat: 37.51, lng: 127.0, start: "20261016", end: "20261018" },
      { title: "먼 축제", lat: 38.5, lng: 127.0, start: "20261016", end: "20261018" },
      { title: "끝난 축제", lat: 37.5, lng: 127.0, start: "20261001", end: "20261010" },
    ];
    expect(buildFacts(base, ctx({ events })).events).toEqual(["가 축제"]);
  });
  it("날씨: 단기예보 우선, 없으면 중기(발표일 기준 n일 뒤, 강원 영동 구역)", () => {
    const weather = { short: { "11110": { days: { "20261017": { sky12: "1", popMax: 20 } } } }, mid: { "11D20000": { tmFc: "202610120600", wf5Pm: "흐림", rnSt5Pm: 40 } } };
    expect(weatherOf(base, weather, mid)).toEqual({ sky: "맑음", rainChancePct: 20 });
    expect(weatherOf({ ...base, provinceCd: "51", signgu: "강릉시", signguCd: "51150" }, weather, mid)).toEqual({ sky: "흐림", rainChancePct: 40 });
  });
  it("같은 사실·프롬프트면 같은 해시, 프롬프트가 바뀌면 다른 해시 (FR-LLM-07)", () => {
    const f = buildFacts(base, ctx());
    expect(factsHash(f, "p1")).toBe(factsHash(buildFacts(base, ctx()), "p1"));
    expect(factsHash(f, "p1")).not.toBe(factsHash(f, "p2"));
  });
});

describe("생성 문장 검증 (FR-LLM-02)", () => {
  const f = buildFacts(base, ctx());
  it("입력에 있는 숫자만, 100자·2문장 이내", () => {
    expect(validReason("평소엔 붐비는데 이날은 평소보다 27만큼 덜 붐빌 것 같아요.", f, 100, 2)).toBe(true);
    expect(validReason("평소보다 30만큼 덜 붐벼요.", f, 100, 2)).toBe(false); // 30 은 사실에 없음
    expect(validReason("가".repeat(101), f, 100, 2)).toBe(false);
    expect(validReason("하나요. 둘이에요. 셋이에요.", f, 100, 2)).toBe(false);
  });
  it("후기 판정 형식", () => {
    expect(isReview({ verdict: "worth_visiting", reason: "단풍 후기가 많아요.", quietTime: "평일 오전", buzz: "" })).toBe(true);
    expect(isReview({ verdict: "maybe", reason: "", quietTime: "", buzz: "" })).toBe(false);
  });
});

describe("OpenAI 호출 (FR-LLM-06·10)", () => {
  const price = { input: 0.1, cachedInput: 0.01, output: 0.5 };
  const reply = (text: string) =>
    new Response(JSON.stringify({ output: [{ type: "reasoning" }, { type: "message", content: [{ type: "output_text", text }] }], usage: { input_tokens: 1000, input_tokens_details: { cached_tokens: 400 }, output_tokens: 100 } }), { status: 200 });
  const call = { model: "m", name: "reason", instructions: "i", input: {}, schema: {}, validate: (v: unknown): v is { reason: string } => typeof (v as { reason?: unknown })?.reason === "string", maxOutputTokens: 50 };
  it("형식이 틀리면 1회 재시도, 두 번 다 틀리면 null. 호출마다 비용을 더한다", async () => {
    const u = emptyUsage();
    let n = 0;
    const bad: typeof fetch = async () => (n++, reply("not json"));
    expect(await callJson("k", call, u, price, bad)).toBeNull();
    expect(n).toBe(2);
    expect(u.calls).toBe(2);
    // (600×0.1 + 400×0.01 + 100×0.5)/1e6 × 2
    expect(u.costUsd).toBeCloseTo(2 * costOf({ inputTokens: 1000, cachedTokens: 400, outputTokens: 100 }, price), 10);
    const ok: typeof fetch = async () => reply('{"reason":"좋아요"}');
    expect(await callJson("k", call, emptyUsage(), price, ok)).toEqual({ reason: "좋아요" });
  });
  it("HTTP 오류는 LlmError(호출 쪽이 정형 문장으로 대신)", async () => {
    const err: typeof fetch = async () => new Response("{}", { status: 429 });
    await expect(callJson("k", call, emptyUsage(), price, err)).rejects.toBeInstanceOf(LlmError);
  });
});

describe("대화 Worker 설정 = config/llm.yaml", () => {
  it("모델·단가·상한이 같다", () => {
    const llm = parse(readFileSync("config/llm.yaml", "utf8"));
    const toml = readFileSync("worker/web/wrangler.toml", "utf8");
    const v = (k: string) => toml.match(new RegExp(`^${k} = "([^"]+)"`, "m"))![1];
    expect(v("MODEL")).toBe(llm.model);
    expect(Number(v("PRICE_INPUT"))).toBe(llm.price.input);
    expect(Number(v("PRICE_CACHED"))).toBe(llm.price.cachedInput);
    expect(Number(v("PRICE_OUTPUT"))).toBe(llm.price.output);
    expect(Number(v("PER_USER_DAILY"))).toBe(llm.chat.perUserDaily);
    expect(Number(v("SERVICE_DAILY"))).toBe(llm.chat.serviceDaily);
    expect(Number(v("CUTOFF_USD"))).toBe(llm.budget.appCutoffUsd);
    expect(Number(v("MAX_INPUT_CHARS"))).toBe(llm.chat.maxInputChars);
    expect(Number(v("MAX_CARDS"))).toBe(llm.chat.maxCards);
  });
});

describe("예산 (review-expert M2)", () => {
  it("생성 상한 + 대화 차단선 ≤ 월 예산", () => {
    const llm = parse(readFileSync("config/llm.yaml", "utf8"));
    expect(llm.generation.monthlyUsd + llm.budget.appCutoffUsd).toBeLessThanOrEqual(llm.budget.monthlyUsd);
  });
  it("문장에 주소·링크가 있으면 버린다", () => {
    expect(validReason("자세한 건 www.example.com 에서 봐요.", buildFacts(base, ctx()), 100, 2)).toBe(false);
  });
});
