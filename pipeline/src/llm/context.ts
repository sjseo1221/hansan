// 근거 문장 사실을 만들 때 필요한 파일을 읽는다 — llm-daily(생성)와 compute-daily(캐시 조회)가 같은 사실·해시를 쓰게 한 곳에서
import { readFile } from "node:fs/promises";
import { parse } from "yaml";
import type { Place } from "../places/build.js";
import { readJson } from "../lib/store.js";
import { TYPE_TEXT } from "../score/public.js";
import { buildFacts, factsHash, type EventItem, type FactInput, type ReasonFacts, type Weather } from "./facts.js";

export interface RecItemLite {
  placeId: string;
  representative: string | null;
  types: string[];
  likelihood: "high" | "medium" | "low" | null;
  forecast: number | null;
  usual: number | null;
  popularity: number | null;
  trend: number | null;
  longTerm: number | null;
  slot?: { start: string; end: string } | null;
}

export async function loadFactContext() {
  const holidays = (await readJson<{ holidays: Record<string, string> }>("data/sources/holidays.json", { holidays: {} })).holidays;
  const events = (await readJson<{ events: EventItem[] }>("data/latest/events.json", { events: [] })).events;
  const weather = await readJson<Weather>("data/latest/weather.json", { short: {}, mid: {} });
  const regions = parse(await readFile("config/regions.yaml", "utf8")) as { midLandRegions: Record<string, string>; midLandGangwonEast: { regId: string; sigungu: string[] } };
  const prompt = await readFile("prompts/reason.md", "utf8");
  return {
    prompt,
    ctx: { typeLabel: (t: string) => TYPE_TEXT[t]?.label ?? t, holidays, events, weather, mid: { byProvince: regions.midLandRegions, gangwonEast: regions.midLandGangwonEast } },
  };
}

export type FactContext = Awaited<ReturnType<typeof loadFactContext>>;

// 날짜별 추천 항목 → (날짜|장소) 별 사실과 해시
export function factsFor(recs: Record<string, { items: RecItemLite[] }>, places: Map<string, Place>, fc: FactContext) {
  const out = new Map<string, { facts: ReasonFacts; hash: string }>();
  for (const [date, rec] of Object.entries(recs)) {
    for (const r of rec.items) {
      const p = places.get(r.placeId);
      if (!p || !r.representative || r.forecast === null || !r.likelihood) continue;
      const input: FactInput = {
        name: p.name,
        lat: p.lat,
        lng: p.lng,
        signguCd: p.region.signguCd,
        signgu: p.region.signgu,
        provinceCd: p.region.provinceCd,
        date,
        rep: r.representative,
        types: r.types,
        likelihood: r.likelihood,
        forecast: r.forecast,
        usual: r.usual,
        popularity: r.popularity,
        trend: r.trend,
        longTerm: r.longTerm,
        slot: r.slot ?? null,
      };
      const facts = buildFacts(input, fc.ctx);
      out.set(`${date}|${r.placeId}`, { facts, hash: factsHash(facts, fc.prompt) });
    }
  }
  return out;
}

export interface ReasonCache {
  [hash: string]: { r: string | null; at: string };
}
export interface ReviewCache {
  [placeId: string]: { verdict: "worth_visiting" | "not_recommended" | "undecided"; reason: string; quietTime: string; buzz: string; n: number; at: string };
}
export const REASONS_PATH = "data/state/llm/reasons.json";
export const REVIEWS_PATH = "data/state/llm/reviews.json";
