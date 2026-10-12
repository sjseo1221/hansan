// 화면과 자료 생성이 함께 쓰는 순수 로직 — 이동 시간(FR-FLT-02)·필터(FR-FLT-03·04)·피드 묶음과 정렬(FR-FEED-02·04)·완화 제안(FR-FLT-06)·규칙 근거 문장
// 브라우저에서도 돌아야 하므로 node 모듈을 쓰지 않는다

export const TYPE_IDS = ["timing_game", "famous_spot", "moderate_hotspot", "time_slot", "hidden_classic", "early_hotspot"] as const;
export type TypeId = (typeof TYPE_IDS)[number];
export type Likelihood = "high" | "medium" | "low";

export interface FeedItem {
  id: string;
  name: string;
  area: string; // "서울 종로구"
  cat: string;
  indoor: "indoor" | "outdoor" | "mixed";
  lat: number;
  lng: number;
  rep: TypeId;
  types: TypeId[];
  lh: Likelihood;
  pop: number | null;
  f: number; // 혼잡 예측
  u: number | null; // 평소 혼잡
  trend: number | null;
  lt: number | null;
  slot?: { start: string; end: string; quietToPeak: number };
  beta?: boolean;
  label?: "실측" | "추정";
  prov?: boolean;
  blocked?: TypeId[];
  reason?: string; // LLM 근거 문장(4단계). 없으면 ruleReason
}

export interface Filters {
  date: string;
  origin: string | null; // 시·군·구 코드
  minutes: number | null; // null = 제한 없음
  companion: string | null;
  indoor: "indoor" | "outdoor" | null; // null = 상관없음
}

export interface FeedConfig {
  travel: { detourFactor: number; speedKmh: number };
  companions: { id: string; label: string; suitable: string[] }[];
  maxPerType: number;
  topN: number;
}

const R = 6371;
export function distanceKm(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLng = (b.lng - a.lng) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

// 직선거리 × 우회 계수 ÷ 속도 → 분. 화면에는 '약'을 붙인다
export const travelMinutes = (km: number, t: FeedConfig["travel"]) => Math.round(((km * t.detourFactor) / t.speedKmh) * 60);

export function matches(item: FeedItem, f: Filters, origin: { lat: number; lng: number } | null, cfg: FeedConfig): boolean {
  if (f.minutes !== null && origin && travelMinutes(distanceKm(origin, item), cfg.travel) > f.minutes) return false;
  if (f.companion) {
    const c = cfg.companions.find((x) => x.id === f.companion);
    if (c && !c.suitable.includes(item.cat)) return false;
  }
  // 실내외 혼합 장소는 실내·실외 어느 쪽을 골라도 남긴다
  if (f.indoor && item.indoor !== "mixed" && item.indoor !== f.indoor) return false;
  return true;
}

const LH_ORDER: Record<Likelihood, number> = { high: 0, medium: 1, low: 2 };

// 유형별 묶음: 대표 유형으로 한 번만 넣는다. 한산 가능성 높은 순 → 인기도 높은 순, 유형당 최대 maxPerType.
// 연속 노출 제한(FR-TYPE-09): 직전 두 주 연속 상위였던 장소는 상위 topN 에 두지 않는다
export function groupFeed(items: FeedItem[], cfg: FeedConfig): Record<TypeId, FeedItem[]> {
  const out = Object.fromEntries(TYPE_IDS.map((t) => [t, [] as FeedItem[]])) as Record<TypeId, FeedItem[]>;
  for (const it of items) out[it.rep]?.push(it);
  for (const t of TYPE_IDS) {
    const sorted = out[t].sort((a, b) => LH_ORDER[a.lh] - LH_ORDER[b.lh] || (b.pop ?? -1) - (a.pop ?? -1) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const top = sorted.filter((x) => !x.blocked?.includes(t)).slice(0, cfg.topN);
    out[t] = [...top, ...sorted.filter((x) => !top.includes(x))].slice(0, cfg.maxPerType);
  }
  return out;
}

// 조건에 맞는 장소가 없을 때 하나씩 풀어 본 결과 수 (FR-FLT-06)
export function relaxations(items: FeedItem[], f: Filters, origin: { lat: number; lng: number } | null, cfg: FeedConfig) {
  const count = (g: Filters) => items.filter((x) => matches(x, g, origin, cfg)).length;
  const out: { key: "minutes" | "companion" | "indoor"; count: number }[] = [];
  if (f.minutes !== null) out.push({ key: "minutes", count: count({ ...f, minutes: null }) });
  if (f.companion) out.push({ key: "companion", count: count({ ...f, companion: null }) });
  if (f.indoor) out.push({ key: "indoor", count: count({ ...f, indoor: null }) });
  return out.filter((x) => x.count > 0).sort((a, b) => b.count - a.count);
}

const pct = (x: number) => `${Math.round(Math.abs(x) * 100)}%`;

// 수치로 만든 근거 문장 — 4단계(FR-LLM) 전까지 쓴다. 쉬운 말로(NFR-UX-03)
export function ruleReason(it: Pick<FeedItem, "pop" | "f" | "u" | "trend" | "lt" | "slot">, type: TypeId): string {
  switch (type) {
    case "famous_spot":
      return `손꼽히게 많이 찾는 곳(상위 ${Math.max(1, Math.round(100 - (it.pop ?? 0)))}%)인데, 이날은 갈 만한 수준으로 붐빌 것 같아요.`;
    case "moderate_hotspot":
      return `많이 찾는 곳(상위 ${Math.max(1, Math.round(100 - (it.pop ?? 0)))}%)인데, 이날 혼잡 예측은 보통 수준이에요.`;
    case "timing_game":
      return `이 요일엔 보통 붐비는 곳인데, 이날은 혼잡 예측이 평소보다 ${Math.round((it.u ?? 0) - it.f)}만큼 낮아요.`;
    case "early_hotspot":
      return `최근 4주 검색이 그 전 8주보다 ${pct(it.trend ?? 0)} 늘었어요. 아직 덜 알려진 곳이에요.`;
    case "time_slot":
      return it.slot ? `${it.slot.start}~${it.slot.end}에는 가장 붐비는 때의 ${pct(it.slot.quietToPeak)} 수준이에요.` : "덜 붐비는 시간대가 있어요.";
    case "hidden_classic":
      return `몇 년 전보다 관심이 ${pct(it.lt ?? 0)} 줄어 한산하지만, 꾸준히 찾는 곳이에요.`;
  }
}
