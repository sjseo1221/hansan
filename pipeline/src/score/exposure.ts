// 유형별 순위와 연속 노출 제한(FR-TYPE-09) — 직전 두 주 연속 상위 topN 에 든 장소는 이번 주 상위 topN 에서 뺀다
import type { DailyRow, TypeId } from "./daily.js";
import type { PlaceScore } from "./place-scores.js";
import { cmp, toDate, weekday } from "./stats.js";

export type ExposureLog = Record<string, Partial<Record<TypeId, string[]>>>; // "YYYY-Www" → 유형 → placeId[]

// ISO 주 (월요일 시작)
export function isoWeek(date: string): string {
  const d = toDate(date);
  const day = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - day + 3); // 그 주 목요일
  const y = d.getUTCFullYear();
  const w = Math.ceil(((d.getTime() - Date.UTC(y, 0, 1)) / 86400000 + 1) / 7);
  return `${y}-W${String(w).padStart(2, "0")}`;
}

// 주 키를 n 주 옮긴다 — 그 주 월요일에서 7일 단위로 옮겨 다시 계산(연말 53주 경계도 맞게)
export function shiftWeek(week: string, n: number): string {
  const [y, w] = week.split("-W").map(Number);
  const jan4 = new Date(Date.UTC(y, 0, 4));
  const monday = jan4.getTime() - ((jan4.getUTCDay() + 6) % 7) * 86400000 + (w - 1) * 7 * 86400000;
  return isoWeek(new Date(monday + n * 7 * 86400000).toISOString().slice(0, 10));
}

// 유형별 정렬 기준(동점은 placeId)
export function rankKey(type: TypeId, r: DailyRow, s: PlaceScore): number[] {
  const f = r.forecast ?? 0;
  switch (type) {
    case "moderate_hotspot":
      return [-(s.popularity ?? 0), Math.abs(f - 50)];
    case "timing_game":
      return [-((r.usual ?? 0) - f)];
    case "early_hotspot":
      return [-(s.trend ?? 0)];
    case "time_slot":
      return [r.slot?.slotCongestion ?? 100, -(s.popularity ?? 0)];
    case "hidden_classic":
      return [f, s.longTerm ?? 0];
  }
}

export function rankType(type: TypeId, rows: DailyRow[], scores: Map<string, PlaceScore>, blocked: Set<string>, topN: number) {
  const order = (a: DailyRow, b: DailyRow) => {
    const ka = rankKey(type, a, scores.get(a.placeId)!);
    const kb = rankKey(type, b, scores.get(b.placeId)!);
    for (let i = 0; i < ka.length; i++) if (ka[i] !== kb[i]) return ka[i] - kb[i];
    return cmp(a.placeId, b.placeId);
  };
  const orig = rows.filter((r) => r.types.includes(type)).sort(order).map((r) => r.placeId);
  const top = orig.filter((id) => !blocked.has(id)).slice(0, topN);
  const final = [...top, ...orig.filter((id) => !top.includes(id))];
  return new Map(final.map((id, i) => [id, { rankRaw: orig.indexOf(id) + 1, rank: i + 1 }]));
}

// 이번 주(W) 차단 대상 = W−1 과 W−2 기록에 모두 있는 장소
export function blockedFor(log: ExposureLog, week: string, type: TypeId, consecutive: number): Set<string> {
  let set = new Set<string>(log[shiftWeek(week, -1)]?.[type] ?? []);
  for (let i = 2; i <= consecutive; i++) {
    const ids = new Set<string>(log[shiftWeek(week, -i)]?.[type] ?? []);
    set = new Set([...set].filter((x) => ids.has(x)));
  }
  return set;
}

export const isWeekend = (date: string) => [0, 6].includes(weekday(date));
