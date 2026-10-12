// 화면용 공개 자료(FR-FEED·FR-FLT·FR-DTL) — compute() 결과를 화면이 바로 읽는 작은 파일들로 나눈다.
// 경로 → 내용. 파일은 public-data 브랜치에 한 커밋으로 덮어써 저장소 이력이 커지지 않게 한다(compute-daily 워크플로)
import type { Place } from "../places/build.js";
import { distanceKm, TYPE_IDS, type FeedItem } from "../shared/feed.js";
import type { compute } from "./compute.js";
import type { DailyRow } from "./daily.js";
import type { ReviewCache } from "../llm/context.js";

type Out = ReturnType<typeof compute>;

const PROVINCE_SHORT: Record<string, string> = { "11": "서울", "28": "인천", "41": "경기", "51": "강원", "43": "충북", "44": "충남", "30": "대전", "36": "세종" };

export const TYPE_TEXT: Record<string, { label: string; desc: string }> = {
  timing_game: { label: "눈치게임", desc: "평소엔 붐비는데 이날은 덜 붐빌 것으로 보이는 곳" },
  moderate_hotspot: { label: "적당한 핫플", desc: "많이 찾는 곳이지만 이날은 보통 수준으로 붐비는 곳" },
  time_slot: { label: "시간대 공략", desc: "인기 장소지만 덜 붐비는 시간대를 노리면 좋은 곳" },
  hidden_classic: { label: "숨은 클래식", desc: "예전보다 관심이 줄어 한산해진 오래된 명소" },
  early_hotspot: { label: "얼리 핫플", desc: "요즘 검색이 빠르게 늘고 있는, 아직 덜 알려진 곳" },
};

// 화면 하단 출처 표시 (NFR-LEGAL-01, docs/sources.md)
export const SOURCES = [
  "한국관광공사 (관광지 정보·집중률 예측·관광 데이터랩)",
  "서울특별시 공공데이터 (실시간 도시데이터)",
  "경기도 (유동인구)",
  "기상청",
  "한국천문연구원 (특일 정보)",
  "네이버 (검색어 트렌드·블로그 검색)",
];

export interface PublicInput {
  asOf: string;
  places: Place[];
  out: Out;
  sigunguNames: Record<string, string>;
  categories: { id: string; label: string }[];
  companions: { id: string; label: string; suitable: string[] }[];
  travel: { detourFactor: number; speedKmh: number; options: (number | null)[] };
  feed: { maxPerType: number };
  topN: number;
  altRadiusKm: number;
  updated: Record<string, string | null>;
  holidays: Record<string, string>; // YYYYMMDD → 이름
  reasons: Record<string, string>; // "YYYY-MM-DD|placeId" → LLM 근거 문장(대표 유형)
  reviews: ReviewCache;
}

const round = (x: number, n = 5) => Math.round(x * 10 ** n) / 10 ** n;

export function buildPublic(input: PublicInput): Record<string, unknown> {
  const { out, asOf } = input;
  const visible = input.places.filter((p) => !p.hidden && !p.stale).sort((a, b) => (a.placeId < b.placeId ? -1 : 1));
  const byId = new Map(visible.map((p) => [p.placeId, p]));
  const areaOf = (p: Place) => `${PROVINCE_SHORT[p.region.provinceCd] ?? ""} ${p.region.provinceCd === "36" ? "" : p.region.signgu}`.trim();
  const files: Record<string, unknown> = {};

  // 출발 지역: 시·군·구별 장소 좌표 평균
  const cents = new Map<string, { lat: number; lng: number; n: number; provinceCd: string }>();
  for (const p of visible) {
    const c = cents.get(p.region.signguCd) ?? cents.set(p.region.signguCd, { lat: 0, lng: 0, n: 0, provinceCd: p.region.provinceCd }).get(p.region.signguCd)!;
    c.lat += p.lat;
    c.lng += p.lng;
    c.n++;
  }
  files["regions.json"] = {
    provinces: Object.entries(PROVINCE_SHORT).map(([code, name]) => ({ code, name })),
    sigungu: [...cents]
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([code, c]) => ({ code, provinceCd: c.provinceCd, name: input.sigunguNames[code] ?? code, lat: round(c.lat / c.n), lng: round(c.lng / c.n) })),
  };

  files["config.json"] = {
    types: TYPE_IDS.map((id) => ({ id, ...TYPE_TEXT[id] })),
    categories: input.categories,
    companions: input.companions,
    travel: input.travel,
    maxPerType: input.feed.maxPerType,
    topN: input.topN,
    sources: SOURCES,
  };

  // 날짜별 피드: 대표 유형이 있는 장소만
  for (const date of out.dates) {
    const rec = out.recommendations[date];
    const items: FeedItem[] = rec.items.flatMap((r) => {
      const p = byId.get(r.placeId);
      if (!p || !r.representative || r.forecast === null || !r.likelihood) return [];
      const blocked = TYPE_IDS.filter((t) => r.ranks[t]?.blocked);
      return [
        {
          id: p.placeId,
          name: p.name,
          area: areaOf(p),
          cat: p.category,
          indoor: p.indoor as FeedItem["indoor"],
          lat: round(p.lat),
          lng: round(p.lng),
          rep: r.representative as FeedItem["rep"],
          types: r.types as FeedItem["types"],
          lh: r.likelihood,
          pop: r.popularity,
          f: r.forecast,
          u: r.usual,
          trend: r.trend,
          lt: r.longTerm,
          ...(r.slot ? { slot: { start: r.slot.start, end: r.slot.end, quietToPeak: r.slot.quietToPeak } } : {}),
          ...(r.beta ? { beta: true } : {}),
          ...(r.patternLabel ? { label: r.patternLabel } : {}),
          ...(r.provisional ? { prov: true } : {}),
          ...(blocked.length ? { blocked } : {}),
          ...(input.reasons[`${date}|${p.placeId}`] ? { reason: input.reasons[`${date}|${p.placeId}`] } : {}),
        },
      ];
    });
    files[`feed/${date}.json`] = { date, asOf, items };
  }

  // 근처 장소(대안, FR-DTL-05): 반경 안 가까운 30곳을 한 번만 구한다
  const near = new Map<string, { id: string; km: number }[]>();
  for (const a of visible) {
    const list: { id: string; km: number }[] = [];
    for (const b of visible) {
      if (a === b) continue;
      const km = distanceKm(a, b);
      if (km <= input.altRadiusKm) list.push({ id: b.placeId, km });
    }
    near.set(a.placeId, list.sort((x, y) => x.km - y.km || (x.id < y.id ? -1 : 1)).slice(0, 30));
  }
  const rowIndex = new Map<string, Map<string, DailyRow>>();
  for (const [date, rows] of out.rowsByDate) rowIndex.set(date, new Map(rows.map((r) => [r.placeId, r])));

  // 장소별 상세 자료 — 상세 화면은 이 파일 하나만 읽는다(약 4KB)
  for (const p of visible) {
    const s = out.scores[p.placeId];
    const pat = out.placePatterns[p.placeId];
    const days = out.dates.map((d) => {
      const r = rowIndex.get(d)!.get(p.placeId)!;
      return {
        d,
        f: r.forecast,
        u: r.usual,
        ...(r.usualBasis ? { ub: r.usualBasis } : {}),
        lh: r.likelihood,
        rep: r.representative,
        types: r.types,
        ...(r.slot ? { slot: { start: r.slot.start, end: r.slot.end, quietToPeak: r.slot.quietToPeak } } : {}),
        ...(r.closed ? { closed: true, cr: r.closedReason } : {}),
        ...(r.operationCaution ? { caution: true } : {}),
        ...(r.provisional ? { prov: true } : {}),
        ...(r.forecastStale ? { fs: true } : {}),
        ...(input.reasons[`${d}|${p.placeId}`] ? { reason: input.reasons[`${d}|${p.placeId}`] } : {}),
      };
    });
    const alt: Record<string, [string, string, number][]> = {};
    for (const d of out.dates) {
      const idx = rowIndex.get(d)!;
      alt[d] = (near.get(p.placeId) ?? [])
        .filter(({ id }) => {
          const r = idx.get(id);
          return r && !r.closed && r.forecast !== null && r.likelihood === "high";
        })
        .slice(0, 3)
        .map(({ id, km }) => {
          const q = byId.get(id)!;
          return [id, q.name, Math.round(km * 10) / 10];
        });
    }
    files[`place/${p.placeId}.json`] = {
      id: p.placeId,
      asOf,
      name: p.name,
      addr: p.address,
      area: areaOf(p),
      cat: p.category,
      indoor: p.indoor,
      op: p.operation ? { rest: p.operation.rest, hours: p.operation.hours } : null,
      lat: round(p.lat),
      lng: round(p.lng),
      pop: s?.popularity ?? null,
      trend: s?.trend ?? null,
      lt: s?.longTerm ?? null,
      ...(pat ? { pat: { basis: pat.basis, label: pat.label, wd: pat.weekday, hd: pat.holiday } } : {}),
      // 후기 판정(FR-LLM-03~05): 판정 이유는 숨은 클래식에, 시간대 언급·화제 이유는 상세에
      ...(input.reviews[p.placeId] ? { review: { verdict: input.reviews[p.placeId].verdict, reason: input.reviews[p.placeId].reason, quietTime: input.reviews[p.placeId].quietTime, buzz: input.reviews[p.placeId].buzz } } : {}),
      days,
      alt,
    };
  }

  // 계산 기간 안의 공휴일 — 상세 화면이 휴일 시간대 패턴을 고르는 데 쓴다
  const holidays = out.dates.filter((d) => input.holidays[d.replaceAll("-", "")]);
  files["meta.json"] = { asOf, dates: out.dates, holidays, updated: input.updated };
  return files;
}
