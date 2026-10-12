// 보조 자료 매일 수집: 방문자수(FR-DATA-03) · 행사·날씨·공휴일(FR-DATA-08) · 운영 정보(FR-DATA-09, 요일 묶음)
// 단계마다 따로 실패를 기록하고, 하나라도 실패하면 종료 코드 1 (FR-OPS-04)
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { parse } from "yaml";
import { collectEvents, collectHolidays, collectOperation, collectVisitors, collectWeather } from "../collect/supplement.js";
import { weekdayBucket } from "../collect/naver.js";
import { datagokr } from "../lib/datagokr.js";
import { appendJsonl, readJson } from "../lib/store.js";
import { kstIso, kstParts } from "../lib/time.js";
import { DailyUsage } from "../lib/usage.js";
import type { Place } from "../places/build.js";

if (existsSync(".env")) process.loadEnvFile(".env");
const key = process.env.DATA_GO_KR_KEY;
if (!key) {
  console.error("DATA_GO_KR_KEY 가 없습니다.");
  process.exit(1);
}

const now = new Date();
const t = kstParts(now);
const yaml = async <T,>(p: string) => parse(await readFile(p, "utf8")) as T;
const src = await yaml<{ aux: Record<string, number>; tour: { dailyCap: number } }>("config/sources.yaml");
const regions = await yaml<{ provinces: { code: string }[]; midLandRegions: Record<string, string>; midLandGangwonEast: { regId: string; sigungu: string[] } }>("config/regions.yaml");
const provinces = regions.provinces.map((p) => p.code);
const usage = (source: string, cap: number) => DailyUsage.load("data", source, t.date, cap);

const kto = datagokr(key);
const kma = datagokr(key, 30000, { base: "https://apis.data.go.kr/1360000", defaults: {} });
const kasi = datagokr(key, 30000, { base: "https://apis.data.go.kr/B090041/openapi/service/SpcdeInfoService", defaults: {} });

const { places } = await readJson<{ places: Place[] }>("data/places/places.json", { places: [] });
const visible = places.filter((p) => !p.hidden);
const { sigungu } = await readJson<{ sigungu: { code: string }[] }>("data/sources/regions/sigungu.json", { sigungu: [] });
// 세종처럼 시·군·구가 하나뿐인 시·도는 그 5자리 코드로 조회한다(build-places 와 같은 규칙)
const regnParams = provinces.map((p) => {
  const own = sigungu.filter((s) => s.code.startsWith(p));
  return own.length === 1 ? own[0].code : p;
});

// 시·군·구 대표 좌표 = 그 시·군·구 장소 좌표 평균
const bySg = new Map<string, { lat: number; lng: number; n: number }>();
for (const p of visible) {
  const a = bySg.get(p.region.signguCd) ?? { lat: 0, lng: 0, n: 0 };
  bySg.set(p.region.signguCd, { lat: a.lat + p.lat, lng: a.lng + p.lng, n: a.n + 1 });
}
const points = [...bySg].map(([signguCd, a]) => ({ signguCd, lat: a.lat / a.n, lng: a.lng / a.n }));
const midRegions = [...new Set([...Object.values(regions.midLandRegions), regions.midLandGangwonEast.regId])];

const results: Record<string, unknown> = {};
let failed = false;
const step = async (name: string, fn: () => Promise<unknown>) => {
  try {
    results[name] = await fn();
  } catch (e) {
    failed = true;
    results[name] = { error: (e as Error).name };
    await appendJsonl(`data/state/failures/${t.yyyy}-${t.mm}.jsonl`, [{ at: kstIso(now), source: `aux_${name}`, code: (e as Error).name, message: "요청 실패" }]);
  }
};

await step("visitors", async () => collectVisitors({ get: kto, usage: await usage("datalab", src.aux.datalabDailyCap), provinces, dataDir: "data", now, firstLookbackDays: src.aux.visitorsFirstLookbackDays }));
await step("events", async () => collectEvents({ get: kto, usage: await usage("tour", src.tour.dailyCap), regnParams, dataDir: "data", now, horizonDays: src.aux.eventsHorizonDays }));
await step("holidays", async () => collectHolidays({ get: kasi, usage: await usage("kasi", src.aux.kasiDailyCap), dataDir: "data", now, months: src.aux.holidayMonths }));
await step("weather", async () => {
  const r = await collectWeather({ get: kma, usage: await usage("kma", src.aux.kmaDailyCap), points, midRegions, dataDir: "data", now });
  if (r.ok === 0 && r.points > 0) throw Object.assign(new Error("날씨 0건"), { name: "EMPTY" });
  return r;
});
await step("operation", async () => {
  // 오늘 요일 묶음만 — 장소마다 주 1회 갱신(네이버와 같은 묶음 규칙)
  const today = new Date(now.getTime() + 9 * 3600_000).getUTCDay();
  const targets = visible
    .filter((p) => p.external.tour && weekdayBucket(p.placeId) === today)
    .map((p) => ({ placeId: p.placeId, contentId: p.external.tour!.contentId, contentTypeId: p.external.tour!.contentTypeId }));
  const r = await collectOperation({ get: kto, usage: await usage("tour", src.tour.dailyCap), places: targets, dataDir: "data", now });
  if (r.attempted > 0 && r.failed / r.attempted > 0.5) throw Object.assign(new Error("운영 정보 실패율 초과"), { name: "FAILURE_RATE" });
  return r;
});

console.log(JSON.stringify(results));
process.exit(failed ? 1 : 0);
