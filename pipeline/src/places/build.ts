// 장소 목록 생성 (FR-DATA-01·13, SRS 9절). 설계서 tasks/hansan-phase1-foundation/workers/claude-main/result.md
// 운영자는 data/places/overrides.yaml 만 고친다. places.json 은 매번 다시 만든다.
import type { Attraction } from "../collect/cnctr.js";
import type { Candidate } from "../collect/tour.js";
import { PROVINCE_HEADS, matchOne, norm, type Match } from "./match.js";

export interface CategoryConfig {
  categories: { id: string; indoor: string }[];
  lclsMap: Record<string, string>; // 신분류 코드(중분류 우선, 대분류) → 분류 id
  typeFallback: Record<string, string>; // 콘텐츠 유형 → 분류 id (신분류가 없을 때)
  typePriority: string[];
}

export interface Overrides {
  places?: Record<string, Partial<Pick<Place, "hidden" | "keyword" | "name" | "category" | "indoor">> & { seoulAreaCd?: string }>;
  matches?: { signguCd: string; tAtsNm: string; contentId: string | null }[];
  add?: Place[];
}

export interface Place {
  placeId: string;
  name: string;
  address: string;
  region: { provinceCd: string; signguCd: string; signgu: string; adminDong: null };
  lat: number;
  lng: number;
  category: string;
  indoor: string;
  operation: null | { rest: string; hours: string; updatedAt: string }; // FR-DATA-09 원문, build-places 가 병합
  keyword: string;
  external: { tour?: { contentId: string; contentTypeId: string; lclsSystm3: string }; cnctr?: { signguCd: string; tAtsNm: string }; seoulAreaCd?: string };
  match: { method: string; confidence: string };
  hidden: boolean;
  // 이번 생성에서 다시 매칭되지 않고 직전 목록에서 이월된 장소 — 수집·추천 대상에서 빠진다(2차 리뷰: 잘못 매칭된 옛 장소가 계속 남던 문제)
  stale?: boolean;
  staleSince?: string;
  lastSeenAt: string;
  sources: string[];
}

export const SHRINK_LIMIT = 0.3;

// 한국 좌표 범위 — 빈 문자열이 0 이 되어 바다 한가운데 장소가 생기던 문제(2차 리뷰 Critical) 방지
export const validCoord = (lat: number, lng: number) => Number.isFinite(lat) && Number.isFinite(lng) && lat >= 33 && lat <= 39.5 && lng >= 124 && lng <= 132;

// 이름 괄호 속 지역 표기 판별용 지역명(시·도 약칭 + 시·군·구 이름과 그 머리말)
export function regionHeadsOf(sigunguNames: string[]): Set<string> {
  const heads = new Set(PROVINCE_HEADS);
  for (const n of sigunguNames) for (const w of n.split(/\s+/)) {
    heads.add(norm(w));
    const h = w.replace(/(특별자치시|특별시|광역시|시|군|구)$/, "");
    if (h.length >= 2) heads.add(norm(h));
  }
  return heads;
}
export const SHORT_NAME = 3;

export function categoryOf(c: Candidate, cfg: CategoryConfig): string | null {
  // 신분류가 있으면 신분류로만 판단한다(숙박·음식처럼 표에 없는 신분류는 빼야 하므로 유형으로 되살리지 않는다)
  if (c.lclsSystm1) return cfg.lclsMap[c.lclsSystm2] ?? cfg.lclsMap[c.lclsSystm1] ?? null;
  return cfg.typeFallback[c.contenttypeid] ?? null;
}

// 네이버 검색어: 괄호를 지운 이름, 너무 짧으면 시·군·구 이름(첫 낱말, 끝 글자 시·군·구 제거)을 앞에 붙인다
export function keywordOf(name: string, signgu: string): string {
  const base = name.replace(/\([^)]*\)|\[[^\]]*\]/g, "").replace(/\s+/g, " ").trim();
  if (norm(base).length > SHORT_NAME) return base;
  const first = signgu.split(" ")[0];
  const head = first.replace(/(특별자치시|시|군|구)$/, "");
  // '동구'→'동' 처럼 한 글자만 남으면 검색어가 망가진다(2026-10-12 '동 문충사' 확인) — 그때는 원래 이름을 쓴다
  const prefix = head.length >= 2 ? head : first;
  return prefix ? `${prefix} ${base}` : base;
}

export function buildPlaces(input: {
  attractions: Attraction[];
  candidates: Candidate[];
  sigunguNames: Record<string, string>;
  seoulPlaces: { areaCd: string; areaNm: string }[];
  overrides: Overrides;
  previous: Place[];
  cfg: CategoryConfig;
  today: string;
}) {
  const { attractions, candidates, overrides, previous, cfg, today } = input;
  const known = new Set(cfg.categories.map((c) => c.id));
  const indoorOf = new Map(cfg.categories.map((c) => [c.id, c.indoor]));
  const warnings: string[] = [];

  const regionHeads = regionHeadsOf(Object.values(input.sigunguNames));
  const excludedByCoord: string[] = [];
  const byProvince = new Map<string, Candidate[]>();
  for (const c of candidates.filter((c) => validCoord(c.mapy, c.mapx) || (excludedByCoord.push(`${c.title}(${c.contentid})`), false))) (byProvince.get(c.lDongRegnCd) ?? byProvince.set(c.lDongRegnCd, []).get(c.lDongRegnCd)!).push(c);
  const byId = new Map(candidates.map((c) => [c.contentid, c]));
  const manual = new Map((overrides.matches ?? []).map((m) => [`${m.signguCd}|${m.tAtsNm}`, m.contentId]));
  for (const m of overrides.matches ?? []) if (m.contentId && !byId.has(m.contentId)) warnings.push(`overrides.matches: 없는 contentId ${m.contentId}`);

  const matched: Match[] = [];
  const unmatched: Attraction[] = [];
  for (const a of attractions) {
    const m = matchOne(a, byProvince, { typePriority: cfg.typePriority, manual, byId, regionHeads });
    if (m) matched.push(m);
    else unmatched.push(a);
  }

  const places = new Map<string, Place>();
  const duplicates: string[] = [];
  const excludedByCategory: string[] = [];
  // 같은 후보를 노리는 매칭이 여럿이면 신뢰도 → 방법 순으로 앞선 것이 갖는다(2차 리뷰 m4)
  const order = { manual: 0, exact: 1, normalized: 2, partial: 3 } as Record<string, number>;
  const conf = { high: 0, medium: 1, low: 2 } as Record<string, number>;
  matched.sort((x, y) => conf[x.confidence] - conf[y.confidence] || order[x.method] - order[y.method] || x.attraction.tAtsNm.localeCompare(y.attraction.tAtsNm));
  for (const m of matched) {
    const c = m.candidate;
    const id = `kto-${c.contentid}`;
    if (places.has(id)) {
      duplicates.push(`${m.attraction.signguCd}|${m.attraction.tAtsNm} → ${id}`);
      continue;
    }
    const category = categoryOf(c, cfg);
    if (!category) {
      excludedByCategory.push(`${c.title}(${c.lclsSystm2 || c.contenttypeid})`);
      continue;
    }
    const signguCd = `${c.lDongRegnCd}${c.lDongSignguCd}`;
    const signgu = input.sigunguNames[signguCd] ?? m.attraction.signguNm;
    places.set(id, {
      placeId: id,
      name: c.title,
      address: c.addr1,
      region: { provinceCd: c.lDongRegnCd, signguCd, signgu, adminDong: null },
      lat: c.mapy,
      lng: c.mapx,
      category,
      indoor: indoorOf.get(category) ?? "mixed",
      operation: null,
      keyword: keywordOf(c.title, signgu),
      external: {
        tour: { contentId: c.contentid, contentTypeId: c.contenttypeid, lclsSystm3: c.lclsSystm3 },
        cnctr: { signguCd: m.attraction.signguCd, tAtsNm: m.attraction.tAtsNm },
      },
      match: { method: m.method, confidence: m.confidence },
      hidden: false,
      lastSeenAt: m.attraction.lastSeen,
      sources: ["tour", "cnctr"],
    });
  }

  // 서울 실시간 인구 장소 연결 — 이름이 정확히 같은 1건만 자동 연결(관광특구·상권은 overrides 로만)
  for (const p of places.values()) {
    if (p.region.provinceCd !== "11") continue;
    const hit = input.seoulPlaces.filter((s) => norm(s.areaNm) === norm(p.name));
    if (hit.length === 1) p.external.seoulAreaCd = hit[0].areaCd;
  }

  // 수동 추가
  for (const a of overrides.add ?? []) {
    if (!known.has(a.category)) throw new Error(`overrides.add: 없는 분류 ${a.category} (${a.placeId})`);
    places.set(a.placeId, { ...a, hidden: a.hidden ?? false, match: { method: "manual", confidence: "high" }, sources: ["manual"] });
  }

  // 이번에 안 나온 직전 장소도 지우지 않는다 — 번호·이력 유지, lastSeenAt 만 멈춘다
  // 복사본을 쓴다 — 아래 보정이 직전 목록(급감 판정의 기준)까지 바꾸지 않게
  const matchedNow = places.size;
  for (const p of previous) {
    if (places.has(p.placeId)) continue;
    const kept = structuredClone(p);
    kept.stale = true;
    kept.staleSince = p.staleSince ?? today;
    places.set(p.placeId, kept);
  }

  // 운영자 보정 적용
  for (const [id, o] of Object.entries(overrides.places ?? {})) {
    const p = places.get(id);
    if (!p) {
      warnings.push(`overrides.places: 없는 placeId ${id}`);
      continue;
    }
    if (o.category && !known.has(o.category)) throw new Error(`overrides.places.${id}: 없는 분류 ${o.category}`);
    const { seoulAreaCd, ...rest } = o;
    Object.assign(p, rest);
    if (seoulAreaCd) p.external.seoulAreaCd = seoulAreaCd;
    if (o.category && !o.indoor) p.indoor = indoorOf.get(o.category) ?? p.indoor;
  }
  // places.json 의 hidden 을 직접 바꾼 경우에도 숨김을 잃지 않는다
  const prevById = new Map(previous.map((p) => [p.placeId, p]));
  for (const p of places.values()) {
    const prev = prevById.get(p.placeId);
    if (prev?.hidden && overrides.places?.[p.placeId]?.hidden === undefined) {
      p.hidden = true;
      warnings.push(`${p.placeId}: places.json 에서 직접 숨김 — overrides.yaml 로 옮기세요`);
    }
  }

  const list = [...places.values()].sort((a, b) => a.placeId.localeCompare(b.placeId));
  const keywordChanged = list.filter((p) => prevById.get(p.placeId) && prevById.get(p.placeId)!.keyword !== p.keyword).map((p) => p.placeId);
  const visible = list.filter((p) => !p.hidden && !p.stale).length;
  // 급감 판정은 '이번에 실제로 매칭된 장소 수' 대 '직전에 매칭돼 있던 장소 수' — 이월 장소는 세지 않는다(2차 리뷰: 가드 무력)
  const prevMatched = previous.filter((p) => !p.stale && !p.hidden).length;
  const shrinkBlocked = prevMatched > 0 && matchedNow < prevMatched * (1 - SHRINK_LIMIT);

  const completeOf = (p: Place) => Boolean(p.name && p.address && p.region.provinceCd && p.region.signguCd && validCoord(p.lat, p.lng) && p.category && p.indoor);
  const count = <T,>(xs: T[], f: (x: T) => string) => xs.reduce<Record<string, number>>((m, x) => ((m[f(x)] = (m[f(x)] ?? 0) + 1), m), {});
  const methods = count(matched, (m) => m.method);
  const report = {
    generatedAt: today,
    attractions: attractions.length,
    matched: { ...methods, total: matched.length, ambiguous: matched.filter((m) => m.ambiguous).length, duplicates: duplicates.length },
    matchRate: attractions.length ? +(matched.length / attractions.length).toFixed(3) : 0,
    unmatched: { count: unmatched.length, list: unmatched.map((a) => ({ signguCd: a.signguCd, signguNm: a.signguNm, tAtsNm: a.tAtsNm })) },
    excludedByCategory,
    excludedByCoord,
    // 시·군·구가 아닌 시·도 범위에서 연결된 매칭 — 사람이 검수할 목록
    crossSigungu: matched.filter((m) => m.confidence === "medium" && !m.ambiguous).map((m) => ({ tAtsNm: m.attraction.tAtsNm, signguNm: m.attraction.signguNm, title: m.candidate.title, addr: m.candidate.addr1 })),
    ambiguousList: matched.filter((m) => m.ambiguous).map((m) => ({ tAtsNm: m.attraction.tAtsNm, signguNm: m.attraction.signguNm, title: m.candidate.title })),
    stale: list.filter((p) => p.stale).map((p) => ({ placeId: p.placeId, name: p.name, staleSince: p.staleSince })),
    places: { total: list.length, visible, hidden: list.length - visible, byProvince: count(list, (p) => p.region.provinceCd), byCategory: count(list, (p) => p.category), seoulLinked: list.filter((p) => p.external.seoulAreaCd).length },
    completeness: { requiredFields: list.length ? +(list.filter(completeOf).length / list.length).toFixed(3) : 0, adminDong: 0, operation: 0 },
    keywordChanged,
    shrinkBlocked,
    warnings,
  };
  return { places: list, report };
}
