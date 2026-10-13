// 근거 문장 입력 사실(FR-LLM-02): 점수·유형·평소 대비 차이·근처 행사·날씨·연휴만. 같은 사실이면 같은 해시 → 재사용(FR-LLM-07)
import { createHash } from "node:crypto";
import { distanceKm } from "../shared/feed.js";

export interface ReasonFacts {
  place: string;
  date: string;
  dateLabel: string;
  weekend: boolean;
  holiday: string | null;
  main: string; // 대표 유형 이름
  types: string[];
  likelihood: "높음" | "보통" | "낮음";
  congestion: number; // 이 장소 평소 대비 혼잡 예측 0~100
  usual: number | null;
  belowUsual: number | null; // 평소 − 예측
  popularityTopPct: number | null; // 상위 몇 %
  searchGrowthPct: number | null; // 최근 4주 / 직전 8주
  interestChangePct: number | null; // 최근 12개월 / 3년 전
  quietSlot: string | null;
  events: string[];
  weather: { sky: string | null; rainChancePct: number | null } | null;
}

export interface FactInput {
  name: string;
  lat: number;
  lng: number;
  signguCd: string;
  signgu: string;
  provinceCd: string;
  date: string; // YYYY-MM-DD
  rep: string;
  types: string[];
  likelihood: "high" | "medium" | "low";
  forecast: number;
  usual: number | null;
  popularity: number | null;
  trend: number | null;
  longTerm: number | null;
  slot?: { start: string; end: string } | null;
}

export interface Weather {
  short: Record<string, { days: Record<string, { sky12?: string; popMax?: number; rain?: boolean }> }>;
  mid: Record<string, Record<string, string | number>>;
}

export interface EventItem {
  title: string;
  lat: number | null;
  lng: number | null;
  start: string; // YYYYMMDD
  end: string;
}

const WD = "일월화수목금토";
const SKY: Record<string, string> = { "1": "맑음", "3": "구름많음", "4": "흐림" };
const LH = { high: "높음", medium: "보통", low: "낮음" } as const;

export function weatherOf(f: FactInput, w: Weather, mid: { byProvince: Record<string, string>; gangwonEast: { regId: string; sigungu: string[] } }): ReasonFacts["weather"] {
  const ymd = f.date.replaceAll("-", "");
  const s = w.short[f.signguCd]?.days?.[ymd];
  if (s && (s.sky12 || s.popMax !== undefined)) return { sky: s.sky12 ? (SKY[s.sky12] ?? null) : null, rainChancePct: s.popMax ?? null };
  const regId = f.provinceCd === "51" && mid.gangwonEast.sigungu.includes(f.signgu) ? mid.gangwonEast.regId : mid.byProvince[f.provinceCd];
  const m = regId ? w.mid[regId] : undefined;
  const tmFc = typeof m?.tmFc === "string" ? m.tmFc.slice(0, 8) : null;
  if (!m || !tmFc) return null;
  const n = Math.round((Date.parse(`${f.date}T00:00:00Z`) - Date.parse(`${tmFc.slice(0, 4)}-${tmFc.slice(4, 6)}-${tmFc.slice(6, 8)}T00:00:00Z`)) / 86400000);
  const key = n >= 4 && n <= 7 ? `${n}Pm` : n >= 8 && n <= 10 ? `${n}` : null;
  if (!key) return null;
  const sky = m[`wf${key}`];
  const rain = m[`rnSt${key}`];
  return { sky: typeof sky === "string" ? sky : null, rainChancePct: typeof rain === "number" ? rain : null };
}

export function buildFacts(
  f: FactInput,
  ctx: { typeLabel: (t: string) => string; holidays: Record<string, string>; events: EventItem[]; weather: Weather; mid: Parameters<typeof weatherOf>[2] },
): ReasonFacts {
  const ymd = f.date.replaceAll("-", "");
  const wd = new Date(`${f.date}T00:00:00Z`).getUTCDay();
  const events = ctx.events
    .filter((e) => e.start <= ymd && ymd <= e.end && e.lat !== null && e.lng !== null && distanceKm(f, { lat: e.lat, lng: e.lng }) <= 10)
    .map((e) => e.title)
    .sort()
    .slice(0, 2);
  return {
    place: f.name,
    date: f.date,
    dateLabel: `${Number(f.date.slice(5, 7))}월 ${Number(f.date.slice(8, 10))}일(${WD[wd]})`,
    weekend: wd === 0 || wd === 6,
    holiday: ctx.holidays[ymd] ?? null,
    main: ctx.typeLabel(f.rep),
    types: f.types.map(ctx.typeLabel),
    likelihood: LH[f.likelihood],
    congestion: Math.round(f.forecast),
    usual: f.usual === null ? null : Math.round(f.usual),
    belowUsual: f.usual === null ? null : Math.round(f.usual - f.forecast),
    popularityTopPct: f.popularity === null ? null : Math.max(1, Math.round(100 - f.popularity)),
    searchGrowthPct: f.trend === null ? null : Math.round(f.trend * 100),
    interestChangePct: f.longTerm === null ? null : Math.round(f.longTerm * 100),
    quietSlot: f.slot ? `${f.slot.start}~${f.slot.end}` : null,
    events,
    weather: weatherOf(f, ctx.weather, ctx.mid),
  };
}

// 프롬프트가 바뀌어도 다시 만든다(해시에 프롬프트 포함)
export const factsHash = (facts: ReasonFacts, prompt: string) => createHash("sha256").update(prompt).update("\n").update(JSON.stringify(facts)).digest("hex").slice(0, 32);

// 생성 문장 검증: 100자·2문장 이내, 문장 속 숫자는 모두 입력 사실에 있어야 한다(FR-LLM-02)
export function validReason(text: string, facts: ReasonFacts, maxChars: number, maxSentences: number): boolean {
  const t = text.trim();
  if (!t || t.length > maxChars) return false;
  if (/https?:|www.|.com|.kr/i.test(t)) return false; // 주소·링크 금지(장소·행사 이름은 외부 자료)
  const sentences = t.split(/(?<=[.!?。])\s*/).filter((s) => s.trim());
  if (sentences.length > maxSentences) return false;
  const allowed = new Set((JSON.stringify(facts).match(/\d+/g) ?? []).map(Number));
  for (const n of t.match(/\d+/g) ?? []) if (!allowed.has(Number(n))) return false;
  return true;
}

export const REASON_SCHEMA = {
  type: "object",
  properties: { reason: { type: "string" } },
  required: ["reason"],
  additionalProperties: false,
} as const;

export const REVIEW_SCHEMA = {
  type: "object",
  properties: {
    verdict: { type: "string", enum: ["worth_visiting", "not_recommended", "undecided"] },
    reason: { type: "string" },
    quietTime: { type: "string" },
    buzz: { type: "string" },
  },
  required: ["verdict", "reason", "quietTime", "buzz"],
  additionalProperties: false,
} as const;

export interface ReviewOut {
  verdict: "worth_visiting" | "not_recommended" | "undecided";
  reason: string;
  quietTime: string;
  buzz: string;
}

export const isReview = (x: unknown): x is ReviewOut => {
  const r = x as ReviewOut;
  return (
    Boolean(r) &&
    ["worth_visiting", "not_recommended", "undecided"].includes(r.verdict) &&
    typeof r.reason === "string" &&
    r.reason.length <= 80 &&
    typeof r.quietTime === "string" &&
    r.quietTime.length <= 40 &&
    typeof r.buzz === "string" &&
    r.buzz.length <= 60
  );
};

// 장소 한 줄 소개(2026-10-13 사용자 요청: 많이 찾는 이유) — 관광공사 소개 글 요약. 숫자·링크는 금지(지어낸 수치를 막는다)
export const KNOWN_SCHEMA = {
  type: "object",
  properties: { known: { type: "string" } },
  required: ["known"],
  additionalProperties: false,
} as const;

export const isKnown = (x: unknown): x is { known: string } => {
  const k = (x as { known?: unknown })?.known;
  return typeof k === "string" && k.trim().length <= 50 && !/\d/.test(k) && !/https?:|www\.|\.com|\.kr/i.test(k);
};
