// 장소 목록 주간 생성 (FR-DATA-01·13): TourAPI 시·군·구 목록·후보 수집 → 집중률 관광지와 이름 매칭 → places.json · report.json
// SKIP_TOUR=1 이면 TourAPI 를 다시 부르지 않고 저장된 후보로만 다시 만든다(매칭 규칙·overrides 조정 시)
import { existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { parse } from "yaml";
import type { Attraction } from "../collect/cnctr.js";
import { collectTour, type Candidate } from "../collect/tour.js";
import { datagokr } from "../lib/datagokr.js";
import { readJson, writeJson } from "../lib/store.js";
import { kstParts } from "../lib/time.js";
import { DailyUsage } from "../lib/usage.js";
import { buildPlaces, type CategoryConfig, type Overrides, type Place } from "../places/build.js";

if (existsSync(".env")) process.loadEnvFile(".env");
const now = new Date();
const yaml = async <T,>(p: string) => parse(await readFile(p, "utf8")) as T;
const regions = await yaml<{ provinces: { code: string }[] }>("config/regions.yaml");
const provinces = regions.provinces.map((p) => p.code);

let tour: unknown = "skipped";
if (process.env.SKIP_TOUR !== "1") {
  const key = process.env.DATA_GO_KR_KEY;
  if (!key) {
    console.error("DATA_GO_KR_KEY 가 없습니다.");
    process.exit(1);
  }
  const src = await yaml<{ tour: { dailyCap: number; types: { contentTypeId: string; keepLcls2?: string[] }[] } }>("config/sources.yaml");
  const usage = await DailyUsage.load("data", "tour", kstParts(now).date, src.tour.dailyCap);
  tour = await collectTour({ get: datagokr(key), usage, provinces, types: src.tour.types, dataDir: "data", now });
}

const candidates: Candidate[] = [];
const candDir = "data/sources/tour/candidates";
if (existsSync(candDir)) for (const f of await readdir(candDir)) candidates.push(...(await readJson<{ candidates: Candidate[] }>(`${candDir}/${f}`, { candidates: [] })).candidates);
const { attractions } = await readJson<{ attractions: Attraction[] }>("data/sources/cnctr/attractions.json", { attractions: [] });
// 첫 실행은 집중률 수집보다 먼저 돌아 관광지 목록이 없다 — 후보·시군구만 받고 정상 종료(알림 없음)
if (attractions.length === 0 && !existsSync("data/places/places.json")) {
  console.log(JSON.stringify({ tour, bootstrap: "집중률 관광지 목록 없음 — 시·군·구·후보만 갱신" }));
  process.exit(0);
}
if (candidates.length === 0 || attractions.length === 0) {
  console.error(JSON.stringify({ tour, error: "후보 또는 집중률 관광지 목록이 없음", candidates: candidates.length, attractions: attractions.length }));
  process.exit(1);
}
const { sigungu } = await readJson<{ sigungu: { code: string; name: string }[] }>("data/sources/regions/sigungu.json", { sigungu: [] });
const { places: seoulPlaces } = await readJson<{ places: { areaCd: string; areaNm: string }[] }>("data/sources/seoul/places.json", { places: [] });
const overrides = (await yaml<Overrides | null>("data/places/overrides.yaml")) ?? {};
const previous = (await readJson<{ places: Place[] }>("data/places/places.json", { places: [] })).places;
const cfg = await yaml<CategoryConfig>("config/categories.yaml");

const { places, report } = buildPlaces({
  attractions,
  candidates,
  sigunguNames: Object.fromEntries(sigungu.map((s) => [s.code, s.name])),
  seoulPlaces,
  overrides,
  previous,
  cfg,
  today: kstParts(now).date,
});

await writeJson("data/places/report.json", { ...report, tour });
// 보이는 장소가 직전보다 크게 줄면 원천 장애로 보고 목록을 바꾸지 않는다 (FR-DATA-11)
if (report.shrinkBlocked) {
  console.error(JSON.stringify({ blocked: "보이는 장소 수 급감 — places.json 미갱신", visible: report.places.visible, previous: previous.filter((p) => !p.hidden).length }));
  process.exit(1);
}
await writeJson("data/places/places.json", { generatedAt: report.generatedAt, source: "build-places", note: "생성 파일 — 수정은 data/places/overrides.yaml", places });

// 검색어가 바뀐 장소는 네이버 트렌드 백필을 다시 받는다
if (report.keywordChanged.length) {
  const path = "data/state/naver_trend_backfilled.json";
  const done = await readJson<string[]>(path, []);
  await writeJson(path, done.filter((id) => !report.keywordChanged.includes(id)));
}

console.log(JSON.stringify({ tour, matchRate: report.matchRate, places: report.places, unmatched: report.unmatched.count, warnings: report.warnings.length }));
