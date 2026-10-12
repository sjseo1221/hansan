// 매일 계산 전체 — 입력 스냅샷 + asOf → 결과. 파일 입출력은 cli/compute-daily.ts 가 한다(같은 입력 → 같은 결과, 시험 가능)
import type { Place } from "../places/build.js";
import { evaluateDay, TYPES, usualOf, type DailyRow, type Thresholds, type TypeId } from "./daily.js";
import { blockedFor, isoWeek, isWeekend, rankType, shiftWeek, type ExposureLog } from "./exposure.js";
import { daytypeOf, patternFor, seoulPatterns, standardPatterns, type PatternConfig, type SeoulRow } from "./patterns.js";
import { scorePlaces, type PlaceScoreConfig, type PlaceScore, type TrendRow } from "./place-scores.js";
import { addDays, cmp, compact, median } from "./stats.js";

export interface ComputeConfig extends Thresholds, PlaceScoreConfig {
  timePattern: PatternConfig["timePattern"];
  exposure: { maxConsecutiveWeeksInTop: number; topN: number };
  feed: { dateRangeDays: number; maxPerType: number };
  freshness: { staleAfterDays: number };
  forecast: { flatRange: number };
}

export interface ComputeInput {
  asOf: string; // YYYY-MM-DD (KST)
  places: Place[];
  cnctr: Record<string, { fetchedAt: string; attractions: Record<string, Record<string, number>> }>;
  cnctrHistory: Map<string, Map<string, number>>; // "signguCd|tAtsNm" → yyyymmdd → 값
  weekly: Map<string, TrendRow>;
  backfill: Map<string, TrendRow>;
  blogTotal: Map<string, number>;
  seoulRows: SeoulRow[];
  seoulCategory: Record<string, string>;
  seoulCategoryMap: Record<string, string>;
  gg: Record<string, Record<string, number>>;
  ggLink: Record<string, string>;
  holidays: Record<string, string>;
  reviewVerdicts?: Record<string, string>;
  navRank?: Map<string, number>; // 티맵 내비 기반 중심 관광지 순위(FR-DATA-14)
  exposure: ExposureLog;
}

export interface RecItem extends DailyRow {
  popularity: number | null;
  trend: number | null;
  longTerm: number | null;
  beta: boolean;
  patternLabel: "실측" | "추정" | null;
  ranks: Partial<Record<TypeId, { rankRaw: number; rank: number; blocked?: boolean }>>;
  reason: null;
  reasonMethod: "pending";
}

export function compute(input: ComputeInput, cfg: ComputeConfig) {
  const { asOf } = input;
  const visible = input.places.filter((p) => !p.hidden && !p.stale).sort((a, b) => cmp(a.placeId, b.placeId));
  const scores = scorePlaces({ placeIds: visible.map((p) => p.placeId), weekly: input.weekly, backfill: input.backfill, blogTotal: input.blogTotal, navRank: input.navRank, cfg });
  const holidaySet = new Set(Object.keys(input.holidays));
  const pcfg: PatternConfig = { timePattern: cfg.timePattern, timeSlot: cfg.timeSlot };
  const seoul = seoulPatterns(input.seoulRows, holidaySet, pcfg);
  const std = standardPatterns(seoul, input.seoulCategory, input.seoulCategoryMap, pcfg);
  const pats = { seoul, ...std };
  const dates = Array.from({ length: cfg.feed.dateRangeDays }, (_, i) => addDays(asOf, i));

  const patternBasis: Record<string, number> = {};
  const placeOut: Record<string, PlaceScore & { patternLabel?: string; patternBasis?: string }> = {};
  const rowsByDate = new Map<string, DailyRow[]>();
  // 상세 화면용: 장소별 평일·휴일 시간대 패턴
  const placePatterns: Record<string, { basis: string; label: string; weekday: (number | null)[]; holiday: (number | null)[] }> = {};
  const stats = { forecastStale: 0, forecastFlat: 0, noForecastToday: 0, closedToday: 0, cautionToday: 0, usualBasisToday: {} as Record<string, number> };

  for (const p of visible) {
    const s = scores.get(p.placeId)!;
    const key = `${p.external.cnctr?.signguCd}|${p.external.cnctr?.tAtsNm}`;
    const sg = p.external.cnctr ? input.cnctr[p.external.cnctr.signguCd] : undefined;
    const fc = (p.external.cnctr && sg?.attractions[p.external.cnctr.tAtsNm]) || {};
    const fcVals = Object.values(fc);
    const forecastStale = Boolean(sg && addDays(sg.fetchedAt.slice(0, 10), cfg.freshness.staleAfterDays) < asOf);
    if (forecastStale) stats.forecastStale++;
    if (fcVals.length && Math.max(...fcVals) - Math.min(...fcVals) < cfg.forecast.flatRange) stats.forecastFlat++;
    const window = new Map(Object.entries(fc));
    const placeInfo = { category: p.category, seoulAreaCd: p.external.seoulAreaCd, ggSigungu: input.ggLink[p.placeId] };
    const todayPattern = patternFor(placeInfo, daytypeOf(asOf, holidaySet), pats, input.gg, pcfg);
    placeOut[p.placeId] = { ...s, ...(todayPattern ? { patternLabel: todayPattern.label, patternBasis: todayPattern.basis } : {}) };
    if (todayPattern) patternBasis[todayPattern.basis] = (patternBasis[todayPattern.basis] ?? 0) + 1;
    const pw = patternFor(placeInfo, "weekday", pats, input.gg, pcfg);
    const ph = patternFor(placeInfo, "holiday", pats, input.gg, pcfg);
    if (pw && ph) placePatterns[p.placeId] = { basis: pw.basis, label: pw.label, weekday: pw.pattern, holiday: ph.pattern };

    for (const date of dates) {
      const pattern = patternFor(placeInfo, daytypeOf(date, holidaySet), pats, input.gg, pcfg);
      const row = evaluateDay(
        {
          placeId: p.placeId,
          category: p.category,
          score: s,
          forecast: fc[compact(date)] ?? null,
          forecastStale,
          usual: usualOf(date, asOf, input.cnctrHistory.get(key) ?? new Map(), window, input.holidays, cfg.usualCongestion),
          pattern,
          rest: p.operation?.rest ?? null,
          reviewVerdict: input.reviewVerdicts?.[p.placeId] ?? null,
        },
        date,
        input.holidays,
        cfg,
      );
      (rowsByDate.get(date) ?? rowsByDate.set(date, []).get(date)!).push(row);
      if (date === asOf) {
        if (row.forecast === null) stats.noForecastToday++;
        if (row.closed) stats.closedToday++;
        if (row.operationCaution) stats.cautionToday++;
        const b = row.usual === null ? "none" : row.usualBasis === "history" ? (row.provisional ? "history_provisional" : "history") : "forecast_window";
        stats.usualBasisToday[b] = (stats.usualBasisToday[b] ?? 0) + 1;
      }
    }
  }

  // 순위·연속 노출 제한. 주말 최종 상위는 그 주 노출 기록에 합친다(덮어쓰지 않는다 — 일요일 실행이 토요일 기록을 지우지 않게).
  // 날짜 순으로 바로 반영해, 같은 실행 안에서도 W 주 기록이 W+1 주 차단에 쓰인다. 8주보다 오래된 기록은 지운다
  const exposure: ExposureLog = Object.fromEntries(Object.entries(structuredClone(input.exposure)).filter(([w]) => w >= shiftWeek(isoWeek(asOf), -8)));
  const recommendations: Record<string, { date: string; asOf: string; items: RecItem[]; candidates: Partial<Record<TypeId, string[]>>; closed: number }> = {};
  const typeCounts: Record<string, Record<string, number>> = {};
  for (const date of dates) {
    const rows = rowsByDate.get(date)!;
    const week = isoWeek(date);
    const ranks = new Map<string, RecItem["ranks"]>();
    for (const type of TYPES) {
      const r = rankType(type, rows, scores, blockedFor(exposure, week, type, cfg.exposure.maxConsecutiveWeeksInTop), cfg.exposure.topN);
      for (const [id, v] of r) (ranks.get(id) ?? ranks.set(id, {}).get(id)!)[type] = v;
      if (isWeekend(date)) {
        const top = [...r].filter(([, v]) => v.rank <= cfg.exposure.topN).map(([id]) => id);
        const rec = (exposure[week] ??= {});
        rec[type] = [...new Set([...(rec[type] ?? []), ...top])].sort();
      }
    }
    const items: RecItem[] = rows
      .filter((r) => r.representative)
      .map((r) => {
        const s = scores.get(r.placeId)!;
        return { ...r, popularity: s.popularity, trend: s.trend, longTerm: s.longTerm, beta: r.types.includes("early_hotspot"), patternLabel: (placeOut[r.placeId].patternLabel as RecItem["patternLabel"]) ?? null, ranks: ranks.get(r.placeId) ?? {}, reason: null, reasonMethod: "pending" };
      });
    const candidates: Partial<Record<TypeId, string[]>> = { hidden_classic: rows.filter((r) => r.candidateTypes?.includes("hidden_classic")).map((r) => r.placeId) };
    recommendations[date] = { date, asOf, items, candidates, closed: rows.filter((r) => r.closed).length };
    const tc: Record<string, number> = {};
    for (const t of TYPES) tc[t] = rows.filter((r) => r.types.includes(t)).length;
    tc.hidden_classic_candidates = candidates.hidden_classic!.length;
    tc.insufficient_any = rows.filter((r) => Object.values(r.typeEval).includes("insufficient_data")).length;
    tc.recommended = items.length;
    typeCounts[date] = tc;
  }

  // 확보율 보고서 원자료
  const has = (f: (s: PlaceScore) => unknown) => visible.filter((p) => f(scores.get(p.placeId)!) !== null && f(scores.get(p.placeId)!) !== undefined).length;
  const trends = visible.map((p) => scores.get(p.placeId)!.trend).filter((x): x is number => x !== null);
  const coverage = {
    asOf,
    places: { total: input.places.length, visible: visible.length, hidden: input.places.filter((p) => p.hidden).length, stale: input.places.filter((p) => p.stale).length },
    sources: {
      cnctrLinked: visible.filter((p) => p.external.cnctr).length,
      forecastToday: visible.length - stats.noForecastToday,
      forecastStale: stats.forecastStale,
      forecastFlat: stats.forecastFlat,
      trendWeekly: visible.filter((p) => input.weekly.has(p.placeId)).length,
      trendBackfill: visible.filter((p) => input.backfill.has(p.placeId)).length,
      blog: visible.filter((p) => input.blogTotal.has(p.placeId)).length,
      seoulLinked: visible.filter((p) => p.external.seoulAreaCd).length,
      seoulPatterns: Object.keys(seoul).length,
      ggLinked: visible.filter((p) => input.ggLink[p.placeId]).length,
      navRanked: visible.filter((p) => input.navRank?.has(p.placeId)).length,
      ggLinkedDong: visible.filter((p) => input.ggLink[p.placeId]?.startsWith("d:")).length,
      operation: visible.filter((p) => p.operation).length,
      operationCautionToday: stats.cautionToday,
      closedToday: stats.closedToday,
    },
    scores: {
      popularity: has((s) => s.popularity),
      popularitySearchOnly: visible.filter((p) => scores.get(p.placeId)!.popularityBasis === "search_only").length,
      trend: trends.length,
      trendMedianAdjusted: trends.length ? median(trends) : null,
      longTerm: has((s) => s.longTerm),
      usualToday: stats.usualBasisToday,
      patternBasisToday: patternBasis,
    },
    categoryPatterns: Object.keys(std.category),
    typesByDate: typeCounts,
  };

  return { scores: placeOut, patterns: pats, recommendations, exposure, coverage, rowsByDate, placePatterns, dates };
}
