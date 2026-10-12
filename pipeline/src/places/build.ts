// 장소 목록 생성 (FR-DATA-01·13, SRS 9절). 설계서 tasks/hansan-phase1-foundation/workers/claude-main/result.md
// 운영자는 data/places/overrides.yaml 만 고친다. places.json 은 매번 다시 만든다.
import type { Attraction } from "../collect/cnctr.js";
import type { Candidate } from "../collect/tour.js";
import { matchOne, norm, type Match } from "./match.js";

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
  lastSeenAt: string;
  sources: string[];
}

export const SHRINK_LIMIT = 0.3;
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

  const byProvince = new Map<string, Candidate[]>();
  for (const c of candidates) (byProvince.get(c.lDongRegnCd) ?? byProvince.set(c.lDongRegnCd, []).get(c.lDongRegnCd)!).push(c);
  const byId = new Map(candidates.map((c) => [c.contentid, c]));
  const manual = new Map((overrides.matches ?? []).map((m) => [`${m.signguCd}|${m.tAtsNm}`, m.contentId]));
  for (const m of overrides.matches ?? []) if (m.contentId && !byId.has(m.contentId)) warnings.push(`overrides.matches: 없는 contentId ${m.contentId}`);

  const matched: Match[] = [];
  const unmatched: Attraction[] = [];
  for (const a of attractions) {
    const m = matchOne(a, byProvince, { typePriority: cfg.typePriority, manual, byId });
    if (m) matched.push(m);
    else unmatched.push(a);
  }

  const places = new Map<string, Place>();
  const duplicates: string[] = [];
  const excludedByCategory: string[] = [];
  const order = { manual: 0, exact: 1, normalized: 2, partial: 3 } as Record<string, number>;
  matched.sort((x, y) => order[x.method] - order[y.method] || x.attraction.tAtsNm.localeCompare(y.attraction.tAtsNm));
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
  for (const p of previous) if (!places.has(p.placeId)) places.set(p.placeId, structuredClone(p));

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
  const visible = list.filter((p) => !p.hidden).length;
  const prevVisible = previous.filter((p) => !p.hidden).length;
  const shrinkBlocked = prevVisible > 0 && visible < prevVisible * (1 - SHRINK_LIMIT);

  const completeOf = (p: Place) => Boolean(p.name && p.address && p.region.provinceCd && p.region.signguCd && Number.isFinite(p.lat) && Number.isFinite(p.lng) && p.category && p.indoor);
  const count = <T,>(xs: T[], f: (x: T) => string) => xs.reduce<Record<string, number>>((m, x) => ((m[f(x)] = (m[f(x)] ?? 0) + 1), m), {});
  const methods = count(matched, (m) => m.method);
  const report = {
    generatedAt: today,
    attractions: attractions.length,
    matched: { ...methods, total: matched.length, ambiguous: matched.filter((m) => m.ambiguous).length, duplicates: duplicates.length },
    matchRate: attractions.length ? +(matched.length / attractions.length).toFixed(3) : 0,
    unmatched: { count: unmatched.length, list: unmatched.map((a) => ({ signguCd: a.signguCd, signguNm: a.signguNm, tAtsNm: a.tAtsNm })) },
    excludedByCategory,
    places: { total: list.length, visible, hidden: list.length - visible, byProvince: count(list, (p) => p.region.provinceCd), byCategory: count(list, (p) => p.category), seoulLinked: list.filter((p) => p.external.seoulAreaCd).length },
    completeness: { requiredFields: list.length ? +(list.filter(completeOf).length / list.length).toFixed(3) : 0, adminDong: 0, operation: 0 },
    keywordChanged,
    shrinkBlocked,
    warnings,
  };
  return { places: list, report };
}
