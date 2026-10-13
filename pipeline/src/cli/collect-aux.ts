// 보조 자료 매일 수집: 방문자수(FR-DATA-03) · 행사·날씨·공휴일(FR-DATA-08) · 운영 정보(FR-DATA-09, 요일 묶음) · 장소 소개
// 단계마다 따로 실패를 기록하고, 하나라도 실패하면 종료 코드 1 (FR-OPS-04)
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { parse } from "yaml";
import { collectEvents, collectHolidays, collectOperation, collectOverview, collectVisitors, collectWeather } from "../collect/supplement.js";
import { collectHub } from "../collect/hub.js";
import { collectSeoulFestivals } from "../collect/festival.js";
import { weekdayBucket } from "../collect/naver.js";
import { datagokr } from "../lib/datagokr.js";
import { appendJsonl, readJson } from "../lib/store.js";
import { kstIso, kstParts } from "../lib/time.js";
import { DailyUsage } from "../lib/usage.js";
import { validCoord, type Place } from "../places/build.js";

if (existsSync(".env")) process.loadEnvFile(".env");
const key = process.env.DATA_GO_KR_KEY;
if (!key) {
  console.error("DATA_GO_KR_KEY 가 없습니다.");
  process.exit(1);
}

const now = new Date();
const t = kstParts(now);
const yaml = async <T,>(p: string) => parse(await readFile(p, "utf8")) as T;
const src = await yaml<{ aux: Record<string, number>; tour: { caps: { events: number; operation: number; overview: number } } }>("config/sources.yaml");
const regions = await yaml<{ provinces: { code: string }[]; midLandRegions: Record<string, string>; midLandGangwonEast: { regId: string; sigungu: string[] } }>("config/regions.yaml");
const provinces = regions.provinces.map((p) => p.code);
const usage = (source: string, cap: number) => DailyUsage.load("data", source, t.date, cap);

const kto = datagokr(key);
const kma = datagokr(key, 30000, { base: "https://apis.data.go.kr/1360000", defaults: {} });
const kasi = datagokr(key, 30000, { base: "https://apis.data.go.kr/B090041/openapi/service/SpcdeInfoService", defaults: {} });

const { places } = await readJson<{ places: Place[] }>("data/places/places.json", { places: [] });
const visible = places.filter((p) => !p.hidden && !p.stale);
const { sigungu } = await readJson<{ sigungu: { code: string }[] }>("data/sources/regions/sigungu.json", { sigungu: [] });
// 세종처럼 시·군·구가 하나뿐인 시·도는 그 5자리 코드로 조회한다(build-places 와 같은 규칙)
const regnParams = provinces.map((p) => {
  const own = sigungu.filter((s) => s.code.startsWith(p));
  return own.length === 1 ? own[0].code : p;
});

// 시·군·구 대표 좌표 = 그 시·군·구 장소 좌표 평균 — 범위 밖 좌표는 뺀다(2차 리뷰: 좌표 0 이 섞여 가평 격자가 바다로 감)
const bySg = new Map<string, { lat: number; lng: number; n: number }>();
for (const p of visible.filter((p) => validCoord(p.lat, p.lng))) {
  const a = bySg.get(p.region.signguCd) ?? { lat: 0, lng: 0, n: 0 };
  bySg.set(p.region.signguCd, { lat: a.lat + p.lat, lng: a.lng + p.lng, n: a.n + 1 });
}
const points = [...bySg].map(([signguCd, a]) => ({ signguCd, lat: a.lat / a.n, lng: a.lng / a.n }));
const midRegions = [...new Set([...Object.values(regions.midLandRegions), regions.midLandGangwonEast.regId])];

const results: Record<string, unknown> = {};
let failed = false;
// AUX_ONLY=hub,events 처럼 일부 단계만 돌릴 수 있다(수동 재실행 때 다른 출처의 하루 상한을 다시 쓰지 않게)
const only = process.env.AUX_ONLY ? new Set(process.env.AUX_ONLY.split(",").map((x) => x.trim())) : null;
const step = async (name: string, fn: () => Promise<unknown>) => {
  if (only && !only.has(name)) return;
  try {
    results[name] = await fn();
  } catch (e) {
    failed = true;
    results[name] = { error: (e as Error).name };
    await appendJsonl(`data/state/failures/${t.yyyy}-${t.mm}.jsonl`, [{ at: kstIso(now), source: `aux_${name}`, code: (e as Error).name, message: "요청 실패" }]);
  }
};

await step("visitors", async () => collectVisitors({ get: kto, usage: await usage("datalab", src.aux.datalabDailyCap), provinces, dataDir: "data", now, firstLookbackDays: src.aux.visitorsFirstLookbackDays }));
await step("events", async () => collectEvents({ get: kto, usage: await usage("tour_events", src.tour.caps.events), regnParams, dataDir: "data", now, horizonDays: src.aux.eventsHorizonDays, lookbackDays: src.aux.eventsLookbackDays }));
await step("holidays", async () => collectHolidays({ get: kasi, usage: await usage("kasi", src.aux.kasiDailyCap), dataDir: "data", now, months: src.aux.holidayMonths }));
await step("weather", async () => {
  const r = await collectWeather({ get: kma, usage: await usage("kma", src.aux.kmaDailyCap), points, midRegions, dataDir: "data", now });
  // 일부만 실패해도 20% 를 넘으면 알린다(직전 값은 시·군·구 단위로 유지됨)
  const total = r.points + midRegions.length;
  if (total > 0 && r.failed / total > 0.2) throw Object.assign(new Error(`날씨 실패 ${r.failed}/${total}`), { name: "FAILURE_RATE" });
  return r;
});
await step("operation", async () => {
  // 오늘 요일 묶음만 — 장소마다 주 1회 갱신(네이버와 같은 묶음 규칙)
  const today = new Date(now.getTime() + 9 * 3600_000).getUTCDay();
  const targets = visible
    .filter((p) => p.external.tour && weekdayBucket(p.placeId) === today)
    .map((p) => ({ placeId: p.placeId, contentId: p.external.tour!.contentId, contentTypeId: p.external.tour!.contentTypeId }));
  const r = await collectOperation({ get: kto, usage: await usage("tour_operation", src.tour.caps.operation), places: targets, dataDir: "data", now });
  if (r.attempted > 0 && r.failed / r.attempted > 0.5) throw Object.assign(new Error("운영 정보 실패율 초과"), { name: "FAILURE_RATE" });
  // 하루 상한에 걸려 남은 장소가 있으면 알린다 — 조용히 다음 주로 밀리지 않게(2차 리뷰)
  if (r.capped || r.skipped > 0) throw Object.assign(new Error(`운영 정보 ${r.skipped}곳 미처리`), { name: "DAILY_CAP" });
  return r;
});

// 장소 소개(2026-10-13 사용자 요청: 많이 찾는 이유 설명) — 인기도 높은 장소부터. 상한에 걸려 남은 곳은 다음 날 이어서 받는다(실패로 보지 않음)
await step("overview", async () => {
  const { places: scores } = await readJson<{ places: Record<string, { popularity: number | null }> }>("data/scores/places.json", { places: {} });
  const targets = visible
    .filter((p) => p.external.tour)
    .sort((a, b) => (scores[b.placeId]?.popularity ?? -1) - (scores[a.placeId]?.popularity ?? -1) || (a.placeId < b.placeId ? -1 : 1))
    .map((p) => ({ placeId: p.placeId, contentId: p.external.tour!.contentId }));
  const r = await collectOverview({ get: kto, usage: await usage("tour_overview", src.tour.caps.overview), places: targets, dataDir: "data", now, refreshDays: src.aux.overviewRefreshDays, maxChars: src.aux.overviewMaxChars });
  const tried = r.ok + r.failed;
  if (tried > 0 && r.failed / tried > 0.5) throw Object.assign(new Error("장소 소개 실패율 초과"), { name: "FAILURE_RATE" });
  return r;
});

// 서울시 문화행사 축제(정기 축제 포함) — 서울 키가 있을 때만
await step("festivals", async () => {
  const seoulKey = process.env.SEOUL_OPENAPI_KEY;
  if (!seoulKey) return { skipped: "SEOUL_OPENAPI_KEY 없음" };
  const r = await collectSeoulFestivals({ key: seoulKey, usage: await usage("seoul_events", src.aux.seoulEventsDailyCap), dataDir: "data", now, horizonDays: src.aux.eventsHorizonDays });
  if (r.codes === 0 && r.failed > 0) throw Object.assign(new Error("서울 축제 실패"), { name: "FAILURE_RATE" });
  return r;
});

// 추가 인기도 신호(FR-DATA-14): 티맵 내비 기반 시·군·구 중심 관광지 — 한 달에 한 번(이미 받은 시·군·구는 건너뜀)
await step("hub", async () => {
  const { attractions } = await readJson<{ attractions: { areaCd: string; signguCd: string }[] }>("data/sources/cnctr/attractions.json", { attractions: [] });
  const sigungu = [...new Map(attractions.map((a) => [a.signguCd, { areaCd: a.areaCd, signguCd: a.signguCd }])).values()].sort((a, b) => (a.signguCd < b.signguCd ? -1 : 1));
  const r = await collectHub({ get: kto, usage: await usage("tour_hub", src.aux.hubDailyCap), sigungu, dataDir: "data", now });
  if (r.todo > 0 && r.failed / r.todo > 0.5) throw Object.assign(new Error("중심 관광지 실패율 초과"), { name: "FAILURE_RATE" });
  return r;
});

console.log(JSON.stringify(results));
process.exit(failed ? 1 : 0);
