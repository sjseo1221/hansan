// 날짜별 계산 — 혼잡 예측(FR-SCORE-02)·평소 혼잡(03)·유형 판정(FR-TYPE-01~05)·한산 가능성(06)·대표 유형(07)·휴무(08)
import { closedOn } from "./closed.js";
import type { PlaceScore } from "./place-scores.js";
import { quietSlot, type PatternBasis, type Pattern } from "./patterns.js";
import { addDays, clamp, compact, mean, r1, weekday } from "./stats.js";

export const TYPES = ["moderate_hotspot", "timing_game", "early_hotspot", "time_slot", "hidden_classic"] as const;
export type TypeId = (typeof TYPES)[number];
export type Eval = "pass" | "fail" | "insufficient_data" | "pending_review" | "not_applicable";

export interface Thresholds {
  types: {
    moderate_hotspot: { popularityMin: number; congestionMin: number; congestionMax: number };
    timing_game: { usualCongestionMin: number; dropFromUsualMin: number };
    early_hotspot: { trendMin: number; popularityMax: number; congestionMax: number; beta: boolean };
    time_slot: { popularityMin: number; quietToPeakRatioMax: number };
    hidden_classic: { longTermChangeMax: number; congestionMax: number; reviewVerdict: string; requireReview: boolean };
  };
  representativePriority: TypeId[];
  quietLikelihood: { highMax: number; mediumMax: number };
  usualCongestion: { weeks: number; minWeeks: number; excludeHolidays: boolean; forecastFallback: boolean; forecastFallbackMinDays: number };
  timeSlot: { window: [number, number]; windowByCategory?: Record<string, [number, number]>; slotHours: number; eligibleBases: PatternBasis[] };
}

export type Likelihood = "high" | "medium" | "low";

export interface DailyRow {
  placeId: string;
  forecast: number | null;
  forecastStale?: boolean; // 집중률 수집이 staleAfterDays 넘게 멈춤(NFR-REL-02)
  usual: number | null;
  usualBasis?: "history" | "forecast_window";
  usualWeeks?: number;
  provisional?: boolean;
  closed?: boolean;
  closedReason?: string;
  operationCaution?: boolean;
  slot?: { start: string; end: string; quietToPeak: number; slotCongestion: number | null };
  likelihood: Likelihood | null;
  typeEval: Partial<Record<TypeId, Eval>>;
  types: TypeId[];
  representative: TypeId | null;
  candidateTypes?: TypeId[];
}

export const likelihoodOf = (c: number, q: Thresholds["quietLikelihood"]): Likelihood => (c <= q.highMax ? "high" : c <= q.mediumMax ? "medium" : "low");

// 평소 혼잡: 같은 요일 이력 평균(공휴일 제외). 주 수가 모자라면 임시, 2주도 안 되면 최신 예측창의 같은 요일 평균(임시)
export function usualOf(
  date: string,
  asOf: string,
  history: Map<string, number>,
  window: Map<string, number>,
  holidays: Record<string, string>,
  cfg: Thresholds["usualCongestion"],
): Pick<DailyRow, "usual" | "usualBasis" | "usualWeeks" | "provisional"> {
  const w = weekday(date);
  const skip = (d: string) => cfg.excludeHolidays && Boolean(holidays[compact(d)]);
  const hist: number[] = [];
  for (let d = addDays(date, -7); d >= addDays(asOf, -7 * cfg.weeks) && hist.length < cfg.weeks; d = addDays(d, -7)) {
    const v = history.get(compact(d));
    if (v !== undefined && !skip(d)) hist.push(v);
  }
  if (hist.length >= cfg.minWeeks) return { usual: r1(mean(hist)), usualBasis: "history", usualWeeks: hist.length, provisional: hist.length < cfg.weeks };
  if (cfg.forecastFallback) {
    const xs = [...window].filter(([d]) => d !== compact(date) && weekday(d) === w && !skip(d)).map(([, v]) => v);
    if (xs.length >= cfg.forecastFallbackMinDays) return { usual: r1(mean(xs)), usualBasis: "forecast_window", usualWeeks: 0, provisional: true };
  }
  return { usual: null };
}

export interface PlaceDayInput {
  placeId: string;
  category: string;
  score: PlaceScore;
  forecast: number | null; // 해당일 혼잡 예측(원값)
  forecastStale?: boolean;
  usual: Pick<DailyRow, "usual" | "usualBasis" | "usualWeeks" | "provisional">;
  pattern: { basis: PatternBasis; pattern: Pattern } | null;
  rest: string | null;
  reviewVerdict?: string | null; // 4단계 후기 판정(FR-LLM-03)
}

export function evaluateDay(p: PlaceDayInput, date: string, holidays: Record<string, string>, t: Thresholds): DailyRow {
  const forecast = p.forecast === null ? null : r1(clamp(p.forecast, 0, 100));
  const row: DailyRow = { placeId: p.placeId, forecast, ...(p.forecastStale ? { forecastStale: true } : {}), ...p.usual, likelihood: null, typeEval: {}, types: [], representative: null };
  const c = closedOn(p.rest, date, holidays);
  if (c.caution) row.operationCaution = true;
  if (c.closed) return { ...row, closed: true, closedReason: c.reason };
  if (forecast === null) return row; // 예측이 없는 날은 추천하지 않는다

  const pop = p.score.popularity;
  const ev = row.typeEval;
  const T = t.types;
  ev.moderate_hotspot = pop === null ? "insufficient_data" : pop >= T.moderate_hotspot.popularityMin && forecast >= T.moderate_hotspot.congestionMin && forecast <= T.moderate_hotspot.congestionMax ? "pass" : "fail";
  ev.timing_game =
    row.usual === null ? "insufficient_data" : row.usual >= T.timing_game.usualCongestionMin && r1(row.usual - forecast) >= T.timing_game.dropFromUsualMin ? "pass" : "fail";
  ev.early_hotspot =
    pop === null || p.score.trend === null ? "insufficient_data" : p.score.trend >= T.early_hotspot.trendMin && pop < T.early_hotspot.popularityMax && forecast < T.early_hotspot.congestionMax ? "pass" : "fail";

  // 시간대 공략: 실측·경기 결합 패턴만(분류 표준만 있으면 판정하지 않음)
  const win = t.timeSlot.windowByCategory?.[p.category] ?? t.timeSlot.window;
  const slot = p.pattern ? quietSlot(p.pattern.pattern, win, t.timeSlot.slotHours) : null;
  if (slot) row.slot = { start: slot.start, end: slot.end, quietToPeak: slot.quietToPeak, slotCongestion: slot.windowMean > 0 ? r1(clamp((forecast * slot.quietValue) / slot.windowMean, 0, 100)) : null };
  if (pop === null || !p.pattern || !slot) ev.time_slot = "insufficient_data";
  else if (!t.timeSlot.eligibleBases.includes(p.pattern.basis)) ev.time_slot = "not_applicable";
  else ev.time_slot = pop >= T.time_slot.popularityMin && slot.quietToPeak <= T.time_slot.quietToPeakRatioMax && row.slot!.slotCongestion !== null ? "pass" : "fail";

  // 숨은 클래식: 후기 판정 전에는 후보로만 둔다
  const lt = p.score.longTerm;
  if (lt === null) ev.hidden_classic = "insufficient_data";
  else if (lt <= T.hidden_classic.longTermChangeMax && forecast < T.hidden_classic.congestionMax) {
    if (p.reviewVerdict) ev.hidden_classic = p.reviewVerdict === T.hidden_classic.reviewVerdict ? "pass" : "fail";
    else ev.hidden_classic = T.hidden_classic.requireReview ? "pending_review" : "pass";
  } else ev.hidden_classic = "fail";
  if (ev.hidden_classic === "pending_review") row.candidateTypes = ["hidden_classic"];

  row.types = t.representativePriority.filter((x) => ev[x] === "pass");
  row.representative = row.types[0] ?? null;
  // '임시' 는 평소 혼잡을 쓰는 눈치게임에만 해당한다
  if (!row.types.includes("timing_game")) delete row.provisional;
  const basis = row.representative === "time_slot" && row.slot?.slotCongestion != null ? row.slot.slotCongestion : forecast;
  row.likelihood = likelihoodOf(basis, t.quietLikelihood);
  return row;
}
