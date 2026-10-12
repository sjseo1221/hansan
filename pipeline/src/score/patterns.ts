// 시간대 패턴(FR-SCORE-06~09)과 시간대 공략 구간 계산. 패턴은 24칸, 그 단위 최댓값 = 1
// 날짜 유형은 평일(월~금)·휴일(토·일·공휴일) 두 가지. 설계의 '요일별' 단계는 8주 표본이 차기 전에는 표본이 너무 적어 두지 않았다
import { compact, mean, r3, weekday } from "./stats.js";

export type Daytype = "weekday" | "holiday";
export type Pattern = (number | null)[];
export type PatternBasis = "measured" | "gg_blend" | "category" | "overall";

export interface SeoulRow {
  areaCd: string;
  ppltnMin: number;
  ppltnMax: number;
  ppltnTime: string; // "YYYY-MM-DD HH:mm"
  fetchedAt?: string;
}

export interface PatternConfig {
  timePattern: { minSamples: number; ggAlpha: number; standardExcludeSeoulCategories: string[] };
  timeSlot: { window: [number, number]; windowByCategory?: Record<string, [number, number]>; slotHours: number; eligibleBases: PatternBasis[] };
}

export interface Patterns {
  seoul: Record<string, Record<Daytype, Pattern>>;
  category: Record<string, Record<Daytype, Pattern>>;
  overall: Record<Daytype, Pattern>;
}

export const daytypeOf = (date: string, holidays: Set<string>): Daytype => {
  const w = weekday(date);
  return w === 0 || w === 6 || holidays.has(compact(date)) ? "holiday" : "weekday";
};

// 최댓값 1 로 맞춘다. 값이 없는 칸은 null
export function normalize(p: Pattern): Pattern {
  const max = Math.max(0, ...p.filter((v): v is number => v !== null));
  return p.map((v) => (v === null ? null : max ? r3(v / max) : 0));
}

const hoursFull = (samples: number[][], window: [number, number], min: number) => {
  for (let h = window[0]; h < window[1]; h++) if (samples[h].length < min) return false;
  return true;
};

// 서울 실측: 값 = (최소+최대)/2. (장소, 날짜, 시)가 같으면 마지막 값 하나
export function seoulPatterns(rows: SeoulRow[], holidays: Set<string>, cfg: PatternConfig): Patterns["seoul"] {
  const last = new Map<string, SeoulRow>();
  for (const r of rows) {
    const k = `${r.areaCd}|${r.ppltnTime.slice(0, 13)}`;
    const prev = last.get(k);
    if (!prev || (r.fetchedAt ?? "") >= (prev.fetchedAt ?? "")) last.set(k, r);
  }
  const byArea = new Map<string, Record<Daytype | "all", number[][]>>();
  for (const r of [...last.values()].sort((a, b) => a.ppltnTime.localeCompare(b.ppltnTime))) {
    const a = byArea.get(r.areaCd) ?? byArea.set(r.areaCd, { weekday: grid(), holiday: grid(), all: grid() }).get(r.areaCd)!;
    const h = Number(r.ppltnTime.slice(11, 13));
    const v = (r.ppltnMin + r.ppltnMax) / 2;
    a[daytypeOf(r.ppltnTime.slice(0, 10), holidays)][h].push(v);
    a.all[h].push(v);
  }
  const out: Patterns["seoul"] = {};
  for (const [area, s] of [...byArea].sort(([a], [b]) => a.localeCompare(b))) {
    const all = hoursFull(s.all, cfg.timeSlot.window, 1) ? normalize(s.all.map((x) => (x.length ? mean(x) : null))) : null;
    const pick = (d: Daytype) => (hoursFull(s[d], cfg.timeSlot.window, cfg.timePattern.minSamples) ? normalize(s[d].map((x) => (x.length ? mean(x) : null))) : all);
    const weekday = pick("weekday");
    const holiday = pick("holiday");
    if (weekday && holiday) out[area] = { weekday, holiday };
  }
  return out;
}
const grid = () => Array.from({ length: 24 }, () => [] as number[]);

// 분류 표준: 서울 장소별 정규화 패턴을 분류별로 평균해 다시 정규화. 서울 자료가 없는 분류는 overall 을 쓴다
export function standardPatterns(seoul: Patterns["seoul"], seoulCategory: Record<string, string>, map: Record<string, string>, cfg: PatternConfig) {
  const groups = new Map<string, Record<Daytype, Pattern>[]>();
  const all: Record<Daytype, Pattern>[] = [];
  for (const [area, p] of Object.entries(seoul)) {
    const sc = seoulCategory[area];
    if (!sc || cfg.timePattern.standardExcludeSeoulCategories.includes(sc) || !map[sc]) continue;
    (groups.get(map[sc]) ?? groups.set(map[sc], []).get(map[sc])!).push(p);
    all.push(p);
  }
  const avg = (ps: Record<Daytype, Pattern>[], d: Daytype): Pattern =>
    normalize(Array.from({ length: 24 }, (_, h) => {
      const xs = ps.map((p) => p[d][h]).filter((v): v is number => v !== null);
      return xs.length ? mean(xs) : null;
    }));
  const category: Patterns["category"] = {};
  for (const [c, ps] of [...groups].sort(([a], [b]) => a.localeCompare(b))) category[c] = { weekday: avg(ps, "weekday"), holiday: avg(ps, "holiday") };
  return { category, overall: { weekday: avg(all, "weekday"), holiday: avg(all, "holiday") } };
}

// 장소·날짜의 패턴: 서울 실측 → 경기 결합 → 분류 표준 → overall
export function patternFor(
  place: { category: string; seoulAreaCd?: string; ggSigungu?: string },
  daytype: Daytype,
  pats: Patterns,
  gg: Record<string, Record<string, number>>,
  cfg: PatternConfig,
): { basis: PatternBasis; pattern: Pattern; label: "실측" | "추정" } | null {
  const s = place.seoulAreaCd ? pats.seoul[place.seoulAreaCd] : undefined;
  if (s) return { basis: "measured", pattern: s[daytype], label: "실측" };
  const cat = pats.category[place.category]?.[daytype];
  const base = cat ?? pats.overall[daytype];
  const baseBasis: PatternBasis = cat ? "category" : "overall";
  const g = place.ggSigungu ? gg[place.ggSigungu] : undefined;
  if (g) {
    const a = cfg.timePattern.ggAlpha;
    const blended = base.map((v, h) => {
      const gv = g[String(h).padStart(2, "0")];
      if (gv === undefined) return v;
      return v === null ? gv : a * gv + (1 - a) * v;
    });
    return { basis: "gg_blend", pattern: normalize(blended), label: "추정" };
  }
  if (base.every((v) => v === null)) return null;
  return { basis: baseBasis, pattern: base, label: "추정" };
}

// 방문 창 안에서 slotHours 시간 이동 평균 — 가장 낮은 구간이 추천 시간대. 같으면 이른 시각
export function quietSlot(p: Pattern, window: [number, number], hours: number) {
  let quiet: { start: number; v: number } | null = null;
  let peak = -Infinity;
  for (let s = window[0]; s + hours <= window[1]; s++) {
    const xs = p.slice(s, s + hours);
    if (xs.some((v) => v === null)) return null;
    const v = mean(xs as number[]);
    if (!quiet || v < quiet.v) quiet = { start: s, v };
    if (v > peak) peak = v;
  }
  const inWindow = p.slice(window[0], window[1]);
  if (!quiet || peak <= 0 || inWindow.some((v) => v === null)) return null;
  const pad = (h: number) => `${String(h).padStart(2, "0")}:00`;
  return {
    start: pad(quiet.start),
    end: pad(quiet.start + hours),
    quietToPeak: r3(quiet.v / peak),
    quietValue: quiet.v,
    windowMean: mean(inWindow as number[]),
  };
}
