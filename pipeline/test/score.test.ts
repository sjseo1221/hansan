// 2단계 점수·유형 판정 시험 — 설계(tasks/hansan-phase2-scoring claude-main result 5절) T01~T25 경계값
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { closedOn } from "../src/score/closed.js";
import { compute, type ComputeConfig, type ComputeInput } from "../src/score/compute.js";
import { evaluateDay, likelihoodOf, usualOf, type PlaceDayInput, type Thresholds } from "../src/score/daily.js";
import { blockedFor, isoWeek, rankType, shiftWeek } from "../src/score/exposure.js";
import { patternFor, quietSlot, seoulPatterns, standardPatterns, type Pattern, type PatternConfig } from "../src/score/patterns.js";
import { completeWeeks, longTermOf, scorePlaces, type PlaceScoreConfig, type TrendRow } from "../src/score/place-scores.js";
import { latestBy, percentiles } from "../src/score/stats.js";

const cfg = parse(readFileSync("config/thresholds.yaml", "utf8")) as ComputeConfig;
const clone = <T,>(x: T): T => structuredClone(x);

describe("백분위·중복 줄 (T01·T06)", () => {
  it("[10,20,30] → 0·50·100, 동점은 같은 값, N=1 → 50", () => {
    expect([...percentiles(new Map([["a", 10], ["b", 20], ["c", 30]])).values()]).toEqual([0, 50, 100]);
    expect([...percentiles(new Map([["a", 5], ["b", 5], ["c", 9]])).values()]).toEqual([25, 25, 100]);
    expect(percentiles(new Map([["a", 1]])).get("a")).toBe(50);
  });
  it("같은 키는 fetchedAt 이 가장 늦은 줄", () => {
    const m = latestBy([{ id: "x", v: 1, fetchedAt: "2026-10-12T05" }, { id: "x", v: 3, fetchedAt: "2026-10-12T12" }, { id: "x", v: 2, fetchedAt: "2026-10-12T08" }], (r) => r.id);
    expect(m.get("x")!.v).toBe(3);
  });
});

const week = (id: string, series: [string, number][], fetchedAt = "2026-10-12T05:23:00+09:00"): TrendRow => ({ placeId: id, timeUnit: "week", series, fetchedAt });
// 2026-10-12(월) 수집 → 마지막 완결 주 10-05, 12주 = 07-20 ~ 10-05
const weeks12 = ["07-20", "07-27", "08-03", "08-10", "08-17", "08-24", "08-31", "09-07", "09-14", "09-21", "09-28", "10-05"].map((d) => `2026-${d}`);

describe("검색 주 정리·추세·장기 (T03~T05)", () => {
  it("빠진 주는 0, 미완결 주(수집 주)는 제외", () => {
    const w = completeWeeks(week("a", [["2026-10-05", 0.5], ["2026-10-12", 9]]), 12);
    expect(w).toHaveLength(12);
    expect(w[11]).toBe(0.5);
    expect(w.slice(0, 11).every((x) => x === 0)).toBe(true);
  });
  const pc: PlaceScoreConfig = { ...clone(cfg), trend: { ...cfg.trend, normalizeByMedian: false } };
  const trendOf = (prev: number, recent: number) =>
    scorePlaces({ placeIds: ["a"], weekly: new Map([["a", week("a", weeks12.map((w, i) => [w, i < 8 ? prev : recent]))]]), backfill: new Map(), blogTotal: new Map(), cfg: pc }).get("a")!.trend;
  it("직전 평균 0.0019 → null, 0.002 → 계산. 정확히 2배 → 1.000", () => {
    expect(trendOf(0.0019, 0.01)).toBeNull();
    expect(trendOf(0.002, 0.004)).toBe(1);
  });
  it("장기: 수집 달 제외, 2025-10~2026-09 대 2022-10~2023-09. 과거 창 전에 시작 안 하면 null", () => {
    const months: [string, number][] = [];
    for (let y = 2022; y <= 2026; y++) for (let m = 1; m <= 12; m++) months.push([`${y}-${String(m).padStart(2, "0")}`, y >= 2025 ? 0.5 : 1]);
    const r = longTermOf({ placeId: "a", timeUnit: "month", series: months.filter(([m]) => m <= "2026-10"), fetchedAt: "2026-10-12T00:00:00+09:00" }, pc);
    expect(r.longTermWindow).toEqual({ recent: ["2025-10", "2026-09"], past: ["2022-10", "2023-09"] });
    expect(r.longTerm).toBe(-0.5);
    expect(longTermOf({ placeId: "a", timeUnit: "month", series: months.filter(([m]) => m >= "2023-01"), fetchedAt: "2026-10-12T00:00:00+09:00" }, pc).longTerm).toBeNull();
  });
});

describe("인기도 (T02)", () => {
  it("검색+블로그 가중합을 다시 백분위로, 블로그 없으면 search_only, 검색 없으면 null", () => {
    const weekly = new Map(["a", "b", "c"].map((id, i) => [id, week(id, weeks12.map((w) => [w, (i + 1) * 0.01]))]));
    const s = scorePlaces({ placeIds: ["a", "b", "c", "d"], weekly, backfill: new Map(), blogTotal: new Map([["a", 10], ["b", 5], ["d", 99]]), cfg: clone(cfg) });
    expect(s.get("c")!.popularityBasis).toBe("search_only");
    expect(s.get("d")!.popularity).toBeNull();
    // a: 검색 0·블로그 100 → 40, b: 검색 50·블로그 0 → 30, c: 검색 100(블로그 없음) → 100 → 다시 백분위
    expect([s.get("a")!.popularity, s.get("b")!.popularity, s.get("c")!.popularity]).toEqual([50, 0, 100]);
  });
});

describe("평소 혼잡 (T08)", () => {
  const u = { ...cfg.usualCongestion, forecastFallback: true }; // 설정값(현재 false)과 무관하게 함수 동작을 시험
  const asOf = "2026-12-14"; // 월요일
  const hist = (n: number) => new Map(Array.from({ length: n }, (_, i) => [`2026${["1207", "1130", "1123", "1116", "1109", "1102", "1026", "1019"][i]}`, 80]));
  it("같은 요일 8개 → history, 2개 → 임시, 1개 + 예측창 → forecast_window, 끄면 null", () => {
    expect(usualOf(asOf, asOf, hist(8), new Map(), {}, u)).toMatchObject({ usual: 80, usualBasis: "history", usualWeeks: 8, provisional: false });
    expect(usualOf(asOf, asOf, hist(2), new Map(), {}, u)).toMatchObject({ usualBasis: "history", usualWeeks: 2, provisional: true });
    const win = new Map([["20261214", 10], ["20261221", 60], ["20261228", 70], ["20270104", 80]]);
    expect(usualOf(asOf, asOf, hist(1), win, {}, u)).toMatchObject({ usual: 70, usualBasis: "forecast_window", provisional: true });
    expect(usualOf(asOf, asOf, hist(1), win, {}, { ...u, forecastFallback: false }).usual).toBeNull();
  });
  it("공휴일 이력은 뺀다", () => {
    expect(usualOf(asOf, asOf, hist(2), new Map(), { "20261207": "x" }, u).usual).toBeNull();
  });
});

const base = (o: Partial<PlaceDayInput> = {}): PlaceDayInput => ({
  placeId: "p",
  category: "heritage",
  score: { popularity: 75, trend: 0, longTerm: 0 },
  forecast: 50,
  usual: { usual: null },
  pattern: null,
  rest: null,
  ...o,
});
const ev = (o: Partial<PlaceDayInput>, t: Thresholds = cfg) => evaluateDay(base(o), "2026-10-17", {}, t);

describe("유형 경계값 (T09~T13·T18)", () => {
  it("적당한 핫플: 인기도 69.9/70.0, 예측 39.9/40.0/60.0/60.1", () => {
    expect(ev({ score: { popularity: 69.9, trend: 0, longTerm: 0 } }).typeEval.moderate_hotspot).toBe("fail");
    expect(ev({ score: { popularity: 70, trend: 0, longTerm: 0 } }).typeEval.moderate_hotspot).toBe("pass");
    expect([39.9, 40, 60, 60.1].map((f) => ev({ forecast: f }).typeEval.moderate_hotspot)).toEqual(["fail", "pass", "pass", "fail"]);
  });
  it("눈치게임: 평소 69.9/70, 차이 19.9/20.0, 임시 표시 유지", () => {
    expect(ev({ forecast: 50, usual: { usual: 69.9 } }).typeEval.timing_game).toBe("fail");
    expect(ev({ forecast: 50.1, usual: { usual: 70 } }).typeEval.timing_game).toBe("fail");
    const r = ev({ forecast: 50, usual: { usual: 70, usualBasis: "forecast_window", provisional: true } });
    expect(r.typeEval.timing_game).toBe("pass");
    expect(r.provisional).toBe(true);
  });
  it("얼리 핫플: 추세 0.999/1.000, 인기도 70 탈락, 예측 50 탈락", () => {
    const s = (trend: number, popularity: number) => ({ popularity, trend, longTerm: 0 });
    expect(ev({ score: s(0.999, 60), forecast: 30 }).typeEval.early_hotspot).toBe("fail");
    expect(ev({ score: s(1, 69.9), forecast: 49.9 }).typeEval.early_hotspot).toBe("pass");
    expect(ev({ score: s(1, 70), forecast: 30 }).typeEval.early_hotspot).toBe("fail");
    expect(ev({ score: s(1, 60), forecast: 50 }).typeEval.early_hotspot).toBe("fail");
  });
  it("숨은 클래식: 후기 판정 전 pending_review(유형·대표 제외), 예측 40 탈락, 판정 주입 → pass", () => {
    const r = ev({ score: { popularity: 10, trend: 0, longTerm: -0.3 }, forecast: 39.9 });
    expect(r.typeEval.hidden_classic).toBe("pending_review");
    expect(r.types).not.toContain("hidden_classic");
    expect(r.candidateTypes).toEqual(["hidden_classic"]);
    expect(ev({ score: { popularity: 10, trend: 0, longTerm: -0.3 }, forecast: 40 }).typeEval.hidden_classic).toBe("fail");
    expect(ev({ score: { popularity: 10, trend: 0, longTerm: -0.3 }, forecast: 39.9, reviewVerdict: "worth_visiting" }).types).toContain("hidden_classic");
  });
  it("인기도가 없으면 인기도가 필요한 유형만 판정 제외, 눈치게임은 판정", () => {
    const r = ev({ score: { popularity: null, trend: 1, longTerm: null }, usual: { usual: 90 }, forecast: 50 });
    expect(r.typeEval).toMatchObject({ moderate_hotspot: "insufficient_data", early_hotspot: "insufficient_data", time_slot: "insufficient_data", hidden_classic: "insufficient_data", timing_game: "pass" });
  });
  it("예측이 없는 날은 추천하지 않는다", () => {
    expect(ev({ forecast: null }).representative).toBeNull();
  });
});

describe("시간대 공략·한산 가능성 (T12·T14·T15)", () => {
  // 9~21시 창: 9~10시 0.5, 나머지 1 → 2시간 최저 구간 09~11 비율 0.5
  const pat = (low: number): Pattern => Array.from({ length: 24 }, (_, h) => (h < 9 ? 0 : h < 11 ? low : 1));
  it("방문 창 밖 새벽 최저는 무시, 동률이면 이른 구간", () => {
    expect(quietSlot(pat(0.5), [9, 21], 2)).toMatchObject({ start: "09:00", end: "11:00", quietToPeak: 0.5 });
    expect(quietSlot(Array(24).fill(1), [9, 21], 2)!.start).toBe("09:00");
  });
  it("비율 0.50 통과 · 0.501 탈락, 분류 표준만 있으면 not_applicable", () => {
    expect(ev({ pattern: { basis: "measured", pattern: pat(0.5) } }).typeEval.time_slot).toBe("pass");
    expect(ev({ pattern: { basis: "measured", pattern: pat(0.501) } }).typeEval.time_slot).toBe("fail");
    expect(ev({ pattern: { basis: "category", pattern: pat(0.5) } }).typeEval.time_slot).toBe("not_applicable");
  });
  it("한산 가능성 40.0 높음 · 40.1 보통 · 60.0 보통 · 60.1 낮음", () => {
    expect([40, 40.1, 60, 60.1].map((c) => likelihoodOf(c, cfg.quietLikelihood))).toEqual(["high", "medium", "medium", "low"]);
  });
  it("대표가 시간대 공략이면 추천 시간대 혼잡으로 등급을 매긴다 — slotCongestion = 예측 × 구간 / 창 평균", () => {
    const t = clone(cfg);
    t.representativePriority = ["time_slot", ...cfg.representativePriority.filter((x) => x !== "time_slot")];
    const r = ev({ forecast: 80, pattern: { basis: "measured", pattern: pat(0.5) } }, t);
    // 창 평균 = (0.5×2 + 1×10)/12 = 0.9167 → 80 × 0.5 / 0.9167 = 43.6
    expect(r.slot!.slotCongestion).toBe(43.6);
    expect(r.representative).toBe("time_slot");
    expect(r.likelihood).toBe("medium");
  });
  it("대표 유형은 설정 순서를 따른다 (T16)", () => {
    const o = { score: { popularity: 75, trend: 0, longTerm: 0 }, forecast: 50, usual: { usual: 90 } };
    expect(ev(o).representative).toBe("timing_game");
    expect(ev(o, { ...clone(cfg), representativePriority: ["moderate_hotspot", "timing_game", "time_slot", "hidden_classic", "early_hotspot"] }).representative).toBe("moderate_hotspot");
  });
});

describe("휴무 해석 (T17)", () => {
  const H = { "20261009": "한글날", "20260924": "추석", "20260925": "추석", "20260926": "추석" };
  const c = (t: string, d: string) => closedOn(t, d, H);
  it("매주·범위·주말·날짜·매월", () => {
    expect(c("매주 월요일", "2026-10-12").closed).toBe(true);
    expect(c("매주 월요일", "2026-10-13").closed).toBe(false);
    expect(c("월~금", "2026-10-16").closed).toBe(true);
    expect(c("토요일, 일요일", "2026-10-17").closed).toBe(true);
    expect(c("주말", "2026-10-18").closed).toBe(true);
    expect(c("1월 1일", "2027-01-01").closed).toBe(true);
    expect(c("매월 18일", "2026-10-18").closed).toBe(true);
    expect(c("매월 첫 번째 수요일", "2026-10-07").closed).toBe(true);
    expect(c("매월 첫 번째 수요일", "2026-10-14").closed).toBe(false);
  });
  it("설·추석, 공휴일이면 다음 평일로 옮김", () => {
    expect(c("매주 월요일 / 설·추석 당일", "2026-09-25").closed).toBe(true);
    const shift = "매주 금요일 (단, 금요일이 공휴일인 경우 그 다음 첫 번째 평일 휴관)";
    expect(c(shift, "2026-10-09").closed).toBe(false); // 한글날(금)
    expect(c(shift, "2026-10-12").closed).toBe(true); // 다음 평일(월)
  });
  it("조건부·불명확 문장은 열림 + 주의, 안내 문구는 조건이 아니다", () => {
    expect(c("점포별 상이", "2026-10-12")).toEqual({ closed: false, caution: true });
    expect(c("매주 화요일 (7월~8월 제외)", "2026-10-13")).toEqual({ closed: false, caution: true });
    expect(c("연중무휴 (단, 매주 월요일 민속관 등 일부시설 휴관)", "2026-10-12").closed).toBe(false);
    expect(c("매주 월요일 ※ 전화 문의", "2026-10-12").closed).toBe(true);
    expect(c("연중무휴", "2026-10-12")).toEqual({ closed: false, caution: false });
    expect(c("1월 1일", "2026-10-12").caution).toBe(false);
  });
});

describe("휴무 해석 — 실제 문구 회귀 (review-expert M1~M4)", () => {
  const H = { "20261005": "대체공휴일(개천절)", "20261009": "한글날", "20260924": "추석", "20260925": "추석", "20260926": "추석", "20270207": "설날", "20270208": "설날", "20270209": "설날" };
  const c = (t: string, d: string) => closedOn(t, d, H);
  it("공휴일이면 개관 — 공휴일 월요일은 열고, '다음 첫 번째 평일' 이면 다음 평일에 쉰다", () => {
    expect(c("매주 월요일 (※ 월요일 공휴일인 경우 개관)", "2026-10-05").closed).toBe(false);
    expect(c("매주 월요일 (※ 월요일 공휴일인 경우 개관)", "2026-10-12").closed).toBe(true);
    expect(c("매주 월요일 (단, 월요일이 법정공휴일일 경우 정상 운영)", "2026-10-05").closed).toBe(false);
    const s = "매주 월요일 ※ 단, 월요일이 공휴일인 경우 개방하며, 그 다음 첫 번째 평일에 휴관";
    expect(c(s, "2026-10-05").closed).toBe(false);
    expect(c(s, "2026-10-06").closed).toBe(true);
    expect(c(s, "2026-10-07").closed).toBe(false);
    expect(c("매주 월요일, 화요일 (단, 공휴일인 경우는 정상 개관) / 1월 1일 / 설·추석 당일", "2026-10-05").closed).toBe(false);
    expect(c("매주 월요일 / 법정 공휴일", "2026-10-09").closed).toBe(true);
  });
  it("나열: 첫째·셋째 일요일, 매월 10·20·30일", () => {
    expect(c("매월 첫째, 셋째 일요일 / 1월 1일 / 설·추석 연휴", "2026-10-04").closed).toBe(true);
    expect(c("매월 첫째, 셋째 일요일 / 1월 1일 / 설·추석 연휴", "2026-10-18").closed).toBe(true);
    expect(c("매월 첫째, 셋째 일요일 / 1월 1일 / 설·추석 연휴", "2026-10-11").closed).toBe(false);
    expect(["2026-10-10", "2026-10-20", "2026-10-30", "2026-10-21"].map((d) => c("매월 10일, 20일, 30일", d).closed)).toEqual([true, true, true, false]);
  });
  it("월 범위 계절 구분은 조건부(열림 + 주의)", () => {
    expect(c("[4월~10월] 연중무휴 [11월~3월] 매주 월요일 (단, 월요일 공휴일 시 익일 대체 휴관)", "2026-07-06")).toEqual({ closed: false, caution: true });
    expect(c("[1월~6월 / 9월~12월] - 월요일~화요일[7월~8월]- 월요일", "2026-07-14")).toEqual({ closed: false, caution: true });
  });
  it("'시설' 은 설날이 아니고, '공휴일, 설·추석 연휴 운영' 은 여는 날", () => {
    expect(c("연중무휴 (단, 시설사용은 사전 확인 필요)", "2027-02-08").closed).toBe(false);
    expect(c("매주 수요일※ 공휴일, 설·추석 연휴 운영", "2026-10-09").closed).toBe(false);
    expect(c("매주 수요일※ 공휴일, 설·추석 연휴 운영", "2026-09-25").closed).toBe(false);
    expect(c("매주 월요일 / 1월 1일 / 설·추석 당일", "2027-02-08").closed).toBe(true);
  });
});

const pcfg: PatternConfig = { timePattern: cfg.timePattern, timeSlot: cfg.timeSlot };
describe("시간대 패턴 (T19~T21)", () => {
  const rows = (area: string, date: string, f: (h: number) => number) =>
    Array.from({ length: 24 }, (_, h) => ({ areaCd: area, ppltnMin: f(h), ppltnMax: f(h), ppltnTime: `${date} ${String(h).padStart(2, "0")}:00`, fetchedAt: "x" }));
  it("같은 (장소·시)는 하나, 표본이 모자라면 전체 합산, 최댓값 1", () => {
    const p = seoulPatterns([...rows("A", "2026-10-12", (h) => h), ...rows("A", "2026-10-12", (h) => h * 2).map((r) => ({ ...r, fetchedAt: "y" }))], new Set(), pcfg);
    expect(p.A.weekday[23]).toBe(1);
    expect(p.A.weekday[12]).toBeCloseTo(12 / 23, 3);
    expect(p.A.holiday).toEqual(p.A.weekday); // 휴일 표본 없음 → 전체 합산
  });
  it("인구밀집지역은 분류 표준에서 빼고, 서울 자료 없는 분류는 overall · 경기는 결합 후 최댓값 1", () => {
    const seoul = seoulPatterns([...rows("A", "2026-10-12", (h) => h), ...rows("B", "2026-10-12", (h) => 24 - h)], new Set(), pcfg);
    const std = standardPatterns(seoul, { A: "공원", B: "인구밀집지역" }, { 공원: "nature_park", 인구밀집지역: "street_market" }, pcfg);
    expect(Object.keys(std.category)).toEqual(["nature_park"]);
    const pats = { seoul, ...std };
    expect(patternFor({ category: "exhibition" }, "weekday", pats, {}, pcfg)!.basis).toBe("overall");
    const g = patternFor({ category: "nature_park", ggSigungu: "41111" }, "weekday", pats, { "41111": { "23": 1, "00": 0.2 } }, pcfg)!;
    expect(g.basis).toBe("gg_blend");
    expect(Math.max(...(g.pattern as number[]))).toBe(1);
    expect(patternFor({ category: "nature_park", seoulAreaCd: "A" }, "weekday", pats, {}, pcfg)!.label).toBe("실측");
  });
});

describe("연속 노출 제한 (T22)", () => {
  it("ISO 주 · 직전 두 주 연속 상위면 이번 주 상위 3에서 밀린다, 한 주만이면 유지", () => {
    expect(isoWeek("2026-10-12")).toBe("2026-W42");
    expect(isoWeek("2027-01-01")).toBe("2026-W53");
    expect(shiftWeek("2027-W01", -1)).toBe("2026-W53");
    const log = { "2026-W41": { moderate_hotspot: ["a", "b"] }, "2026-W40": { moderate_hotspot: ["a"] } };
    const blocked = blockedFor(log, "2026-W42", "moderate_hotspot", 2);
    expect([...blocked]).toEqual(["a"]);
    const rows = ["a", "b", "c", "d"].map((id) => ({ ...ev({}), placeId: id }));
    const scores = new Map(["a", "b", "c", "d"].map((id, i) => [id, { popularity: 90 - i, trend: 0, longTerm: 0 }]));
    const r = rankType("moderate_hotspot", rows, scores, blocked, 3);
    expect([...r].map(([id, v]) => [id, v.rankRaw, v.rank])).toEqual([["b", 2, 1], ["c", 3, 2], ["d", 4, 3], ["a", 1, 4]]);
  });
});

describe("결정성·설정 변경 (T23·T24·T25)", () => {
  const place = (id: string, hidden = false) => ({
    placeId: id,
    name: id,
    category: "heritage",
    hidden,
    operation: null,
    region: { provinceCd: "11", signguCd: "11110", signgu: "종로구", adminDong: null },
    external: { cnctr: { signguCd: "11110", tAtsNm: id } },
  });
  const input = (): ComputeInput => ({
    asOf: "2026-10-12",
    places: [place("a"), place("b"), place("h", true)] as unknown as ComputeInput["places"],
    cnctr: { "11110": { fetchedAt: "2026-10-12T04:30:00+09:00", attractions: { a: { "20261012": 50, "20261013": 45 }, b: { "20261012": 55 }, h: { "20261012": 50 } } } },
    cnctrHistory: new Map(),
    weekly: new Map(["a", "b", "h"].map((id, i) => [id, week(id, weeks12.map((w) => [w, 0.01 * (i + 1)]))])),
    backfill: new Map(),
    blogTotal: new Map([["a", 5], ["b", 9]]),
    seoulRows: [],
    seoulCategory: {},
    seoulCategoryMap: {},
    gg: {},
    ggLink: {},
    holidays: {},
    exposure: {},
  });
  it("같은 입력 → 같은 결과, 입력 순서를 섞어도 같다, 숨김은 모집단·결과에서 빠진다", () => {
    const c2 = clone(cfg);
    c2.feed.dateRangeDays = 2;
    const a = JSON.stringify(compute(input(), c2));
    const i2 = input();
    i2.places.reverse();
    expect(JSON.stringify(compute(i2, c2))).toBe(a);
    const out = compute(input(), c2);
    expect(Object.keys(out.scores)).toEqual(["a", "b"]);
    expect(out.scores.b.popularity).toBe(100);
  });
  it("기준값을 설정에서 바꾸면 판정이 바뀐다 (FR-TYPE-10)", () => {
    const c2 = clone(cfg);
    c2.feed.dateRangeDays = 1;
    const before = compute(input(), c2).recommendations["2026-10-12"].items.map((i) => i.placeId);
    c2.types.moderate_hotspot.popularityMin = 0;
    const after = compute(input(), c2).recommendations["2026-10-12"].items.map((i) => i.placeId);
    expect(before).toEqual(["b"]);
    expect(after).toEqual(["a", "b"]);
  });
});

describe("2단계 리뷰 반영 (claude-reviewer C1·M3·M6·M7·M8·N2, review-expert m5)", () => {
  const H = { "20261009": "한글날" };
  const c = (t: string, d: string) => closedOn(t, d, H).closed;
  // 2026-10-12(월) ~ 10-18(일)
  const week7 = (t: string) => ["12", "13", "14", "15", "16", "17", "18"].map((d) => (c(t, `2026-10-${d}`) ? "X" : "o")).join("");
  it("'X요일~Y요일' 범위는 X 부터 — '요일' 의 '일' 을 일요일로 읽지 않는다", () => {
    expect(week7("매주 월요일~금요일")).toBe("XXXXXoo");
    expect(week7("매주 수요일~토요일")).toBe("ooXXXXo");
    expect(week7("매주 금요일~일요일")).toBe("ooooXXX");
    expect(week7("매주 일요일~월요일 / 공휴일")).toBe("XoooooX");
  });
  it("매월 N일이 휴일이면 다음 평일로 옮긴다", () => {
    expect(c("매월 18일※ 18일이 휴일·연휴일 경우 그 다음 평일", "2026-10-18")).toBe(false); // 일요일
    expect(c("매월 18일※ 18일이 휴일·연휴일 경우 그 다음 평일", "2026-10-19")).toBe(true);
    expect(c("매월 18일 (공휴일인 경우 다음 평일)", "2026-11-18")).toBe(true); // 수요일
  });
  it("임시 표시는 눈치게임에만, 예측 정체(forecastStale)는 행에 남는다", () => {
    const r = ev({ score: { popularity: 75, trend: 0, longTerm: 0 }, forecast: 50, usual: { usual: 60, usualBasis: "forecast_window", provisional: true }, forecastStale: true });
    expect(r.types).toEqual(["moderate_hotspot"]);
    expect(r.provisional).toBeUndefined();
    expect(r.forecastStale).toBe(true);
  });
  it("분류 표준 없이 경기 패턴만 있으면 gg_only — 시간대 공략 판정 대상 아님", () => {
    const pats = { seoul: {}, category: {}, overall: { weekday: Array(24).fill(null), holiday: Array(24).fill(null) } };
    const p = patternFor({ category: "heritage", ggSigungu: "41111" }, "weekday", pats, { "41111": { "10": 0.2, "12": 1 } }, pcfg)!;
    expect(p.basis).toBe("gg_only");
    expect(ev({ pattern: { basis: "gg_only", pattern: p.pattern } }).typeEval.time_slot).not.toBe("pass");
  });
  it("공휴일 이력을 빼고도 2주가 남으면 공휴일 값은 평균에서 빠진다", () => {
    const hist = new Map([["20261207", 90], ["20261130", 50], ["20261123", 50]]);
    expect(usualOf("2026-12-14", "2026-12-14", hist, new Map(), { "20261207": "x" }, cfg.usualCongestion)).toMatchObject({ usual: 50, usualWeeks: 2 });
  });
  it("일요일 실행은 같은 주 토요일 노출 기록을 지우지 않는다(합친다)", () => {
    const place = (id: string) => ({ placeId: id, name: id, category: "heritage", hidden: false, operation: null, region: { provinceCd: "11", signguCd: "11110", signgu: "종로구", adminDong: null }, external: { cnctr: { signguCd: "11110", tAtsNm: id } } });
    const c2 = clone(cfg);
    c2.feed.dateRangeDays = 1;
    c2.types.moderate_hotspot.popularityMin = 0; // 장소 1곳이면 인기도 50
    const out = compute(
      {
        asOf: "2026-10-18",
        places: [place("a")] as unknown as ComputeInput["places"],
        cnctr: { "11110": { fetchedAt: "2026-10-18T04:30:00+09:00", attractions: { a: { "20261018": 50 } } } },
        cnctrHistory: new Map(),
        weekly: new Map([["a", week("a", weeks12.map((w) => [w, 0.01]), "2026-10-18T05:00:00+09:00")]]),
        backfill: new Map(),
        blogTotal: new Map([["a", 5]]),
        seoulRows: [], seoulCategory: {}, seoulCategoryMap: {}, gg: {}, ggLink: {}, holidays: {},
        exposure: { "2026-W42": { moderate_hotspot: ["x"] }, "2026-W30": { moderate_hotspot: ["old"] } },
      },
      c2,
    );
    expect(out.exposure["2026-W42"].moderate_hotspot).toEqual(["a", "x"]);
    expect(out.exposure["2026-W30"]).toBeUndefined(); // 8주보다 오래된 기록 정리
  });
});
