// 장소 단위 점수 — 인기도(FR-SCORE-01)·추세(04)·장기 관심 변화(05). 설계: tasks/hansan-phase2-scoring claude-main result 1절
import { addDays, mean, median, percentiles, r3, weekday } from "./stats.js";

export interface TrendRow {
  placeId: string;
  timeUnit: "week" | "month";
  series: [string, number | null][];
  fetchedAt: string;
}

export interface PlaceScoreConfig {
  popularity: { searchWeight: number; blogWeight: number; navWeight?: number };
  trend: { recentWeeks: number; prevWeeks: number; minPrevRatio: number; normalizeByMedian: boolean };
  longTerm: { months: number; yearsBack: number };
}

export interface PlaceScore {
  popularity: number | null;
  popularityBasis?: "search_blog" | "search_only";
  searchBasis?: "week" | "month";
  searchPct?: number;
  blogPct?: number;
  navPct?: number;
  navRank?: number; // 시·군·구 중심 관광지 순위(티맵 내비 기반)
  trend: number | null;
  longTerm: number | null;
  longTermWindow?: { recent: [string, string]; past: [string, string] };
}

// 응답에 없는 주는 검색 비율 0 으로 본다(네이버는 값 0 인 기간을 빼고 준다 — 2026-10-12 실측, 공식 명세 미확인).
// 완결된 주만 쓴다: 주 시작(월) + 6일 < 수집일. 수집기는 항상 13주를 요청하므로 최근 count 주는 모두 요청 범위 안이다
export function completeWeeks(row: TrendRow, count: number): number[] {
  const fetched = row.fetchedAt.slice(0, 10);
  const last = addDays(fetched, -((weekday(fetched) + 6) % 7) - 7);
  const byWeek = new Map(row.series.map(([w, v]) => [w, v ?? 0]));
  const weeks: number[] = [];
  for (let i = count - 1; i >= 0; i--) weeks.push(byWeek.get(addDays(last, -7 * i)) ?? 0);
  return weeks;
}

const addMonths = (ym: string, n: number) => {
  const [y, m] = ym.split("-").map(Number);
  const t = y * 12 + (m - 1) + n;
  return `${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, "0")}`;
};

export function longTermOf(row: TrendRow, cfg: PlaceScoreConfig): Pick<PlaceScore, "longTerm" | "longTermWindow"> {
  const M = row.fetchedAt.slice(0, 7); // 수집한 달은 미완결이라 쓰지 않는다
  const recent: [string, string] = [addMonths(M, -cfg.longTerm.months), addMonths(M, -1)];
  const past: [string, string] = [addMonths(recent[0], -12 * cfg.longTerm.yearsBack), addMonths(recent[1], -12 * cfg.longTerm.yearsBack)];
  const first = row.series[0]?.[0];
  if (!first || first > past[0]) return { longTerm: null };
  const v = new Map(row.series.map(([m, x]) => [m, x ?? 0]));
  let sr = 0;
  let sp = 0;
  for (let i = 0; i < cfg.longTerm.months; i++) {
    sr += v.get(addMonths(recent[0], i)) ?? 0;
    sp += v.get(addMonths(past[0], i)) ?? 0;
  }
  if (sp < cfg.longTerm.months * cfg.trend.minPrevRatio) return { longTerm: null };
  return { longTerm: r3(sr / sp - 1), longTermWindow: { recent, past } };
}

export function scorePlaces(input: {
  placeIds: string[];
  weekly: Map<string, TrendRow>;
  backfill: Map<string, TrendRow>;
  blogTotal: Map<string, number>;
  // 티맵 내비 기반 시·군·구 중심 관광지 순위(1~100, FR-DATA-14). 자료가 없으면(빈 Map) 이 신호를 쓰지 않는다
  navRank?: Map<string, number>;
  cfg: PlaceScoreConfig;
}): Map<string, PlaceScore> {
  const { placeIds, weekly, backfill, blogTotal, cfg } = input;
  const navRank = input.navRank ?? new Map<string, number>();
  const ids = [...placeIds].sort();
  const search = new Map<string, number>();
  const searchBasis = new Map<string, "week" | "month">();
  const rawTrend = new Map<string, number>();
  const n = cfg.trend.recentWeeks + cfg.trend.prevWeeks;
  for (const id of ids) {
    const w = weekly.get(id);
    if (w) {
      const weeks = completeWeeks(w, n);
      search.set(id, mean(weeks.slice(-cfg.trend.recentWeeks)));
      searchBasis.set(id, "week");
      const prev = mean(weeks.slice(0, cfg.trend.prevWeeks));
      if (prev >= cfg.trend.minPrevRatio) rawTrend.set(id, mean(weeks.slice(-cfg.trend.recentWeeks)) / prev - 1);
      continue;
    }
    // 주 단위가 없으면 백필의 마지막 완결 월 비율
    const b = backfill.get(id);
    if (b) {
      const M = b.fetchedAt.slice(0, 7);
      const last = [...b.series].reverse().find(([m]) => m < M);
      if (last) {
        search.set(id, last[1] ?? 0);
        searchBasis.set(id, "month");
      }
    }
  }

  // 기준 키워드 계절성 보정 — 모든 장소가 같은 기준어 대비 비율이라 함께 움직인다
  const med = cfg.trend.normalizeByMedian ? median([...rawTrend.values()]) : 0;
  const ps = percentiles(search);
  const pb = percentiles(new Map(ids.filter((id) => search.has(id) && blogTotal.has(id)).map((id) => [id, blogTotal.get(id)!])));
  // 내비 신호: 상위 100 안이면 101 − 순위, 밖이면 0 (중심 관광지에 못 든 것도 정보다). 검색 자료가 있는 장소끼리 백분위
  const wn = navRank.size ? (cfg.popularity.navWeight ?? 0) : 0;
  const pn = wn ? percentiles(new Map(ids.filter((id) => search.has(id)).map((id) => [id, navRank.has(id) ? 101 - navRank.get(id)! : 0]))) : new Map<string, number>();
  const raw = new Map<string, number>();
  for (const id of ids) {
    if (!ps.has(id)) continue;
    // 있는 신호의 가중치만 다시 나눠 합한다(블로그가 없으면 검색·내비만)
    const parts: [number, number][] = [[cfg.popularity.searchWeight, ps.get(id)!]];
    if (pb.has(id)) parts.push([cfg.popularity.blogWeight, pb.get(id)!]);
    if (wn) parts.push([wn, pn.get(id)!]);
    const w = parts.reduce((a, [x]) => a + x, 0);
    raw.set(id, parts.reduce((a, [x, v]) => a + x * v, 0) / w);
  }
  // 가중합을 한 번 더 백분위로 — '70 이상 = 상위 30%' 가 그대로 성립한다
  const pop = percentiles(raw);

  const out = new Map<string, PlaceScore>();
  for (const id of ids) {
    const t = rawTrend.get(id);
    const lt = backfill.get(id) ? longTermOf(backfill.get(id)!, cfg) : { longTerm: null };
    out.set(id, {
      popularity: pop.get(id) ?? null,
      ...(pop.has(id) ? { popularityBasis: pb.has(id) ? "search_blog" : "search_only", searchBasis: searchBasis.get(id), searchPct: ps.get(id), ...(pb.has(id) ? { blogPct: pb.get(id) } : {}), ...(wn ? { navPct: pn.get(id) } : {}) } : {}),
      ...(navRank.has(id) ? { navRank: navRank.get(id) } : {}),
      trend: t === undefined ? null : r3((1 + t) / (1 + (Number.isFinite(med) ? med : 0)) - 1),
      ...lt,
    });
  }
  return out;
}

