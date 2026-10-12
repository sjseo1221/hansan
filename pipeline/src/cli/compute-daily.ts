// 매일 점수 계산 (FR-SCORE · FR-TYPE). 수집 결과를 읽어 data/scores · data/recommendations · data/reports/coverage 를 쓴다.
// ASOF=YYYY-MM-DD 로 기준일을 고정할 수 있다(재현·시험). 없으면 오늘(KST)
import { existsSync } from "node:fs";
import { readdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { parse } from "yaml";
import type { Place } from "../places/build.js";
import { compute, type ComputeConfig, type ComputeInput } from "../score/compute.js";
import { buildPublic, type PublicInput } from "../score/public.js";
import type { SeoulRow } from "../score/patterns.js";
import type { TrendRow } from "../score/place-scores.js";
import { addDays, latestBy } from "../score/stats.js";
import { readJson, writeJson } from "../lib/store.js";
import { kstParts } from "../lib/time.js";

const yaml = async <T,>(p: string) => parse(await readFile(p, "utf8")) as T;
const asOf = process.env.ASOF ?? kstParts(new Date()).date;

async function jsonl<T>(path: string): Promise<T[]> {
  if (!existsSync(path)) return [];
  return (await readFile(path, "utf8"))
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as T);
}

// data/raw/<src>/YYYY-MM/DD.jsonl 중 [from, to] 날짜 파일
async function dayFiles<T>(src: string, from: string, to: string): Promise<T[]> {
  const out: T[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(...(await jsonl<T>(`data/raw/${src}/${d.slice(0, 7)}/${d.slice(8)}.jsonl`)));
  return out;
}

const cfg = await yaml<ComputeConfig>("config/thresholds.yaml");
const cat = await yaml<{ seoulCategoryMap: Record<string, string> }>("config/categories.yaml");
const { places } = await readJson<{ places: Place[] }>("data/places/places.json", { places: [] });
const cnctr = await readJson<{ sigungu: ComputeInput["cnctr"] }>("data/latest/cnctr.json", { sigungu: {} });

const historyRows = await dayFiles<{ date: string; signguCd: string; tAtsNm: string; cnctrRate: number; fetchedAt: string }>(
  "cnctr_history",
  addDays(asOf, -7 * cfg.usualCongestion.weeks),
  addDays(asOf, -1),
);
const cnctrHistory = new Map<string, Map<string, number>>();
for (const r of latestBy(historyRows, (r) => `${r.signguCd}|${r.tAtsNm}|${r.date}`).values()) {
  const k = `${r.signguCd}|${r.tAtsNm}`;
  (cnctrHistory.get(k) ?? cnctrHistory.set(k, new Map()).get(k)!).set(r.date, r.cnctrRate);
}

// 검색 트렌드: 주 단위는 날짜별 파일(최근 것 우선), 장기는 backfill
const trendDir = "data/raw/naver_trend";
const weeklyRows: TrendRow[] = [];
// 요일 묶음으로 장소마다 주 1회 갱신되므로 14일보다 오래된 행은 쓰지 않는다(낡은 창이 백분위에 섞이지 않게)
const trendFiles = existsSync(trendDir) ? (await readdir(trendDir)).filter((f) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f) && f.slice(0, 10) <= asOf && f.slice(0, 10) >= addDays(asOf, -14)).sort() : [];
for (const f of trendFiles) weeklyRows.push(...(await jsonl<TrendRow>(join(trendDir, f))));
const weekly = latestBy(weeklyRows, (r) => r.placeId);
const backfill = latestBy(await jsonl<TrendRow>(join(trendDir, "backfill.jsonl")), (r) => r.placeId);

// 블로그: 최근 8주 파일의 최신 값
const blogRows = await dayFiles<{ placeId: string; total: number; fetchedAt: string }>("naver_blog", addDays(asOf, -56), asOf);
const blogTotal = new Map([...latestBy(blogRows, (r) => r.placeId)].map(([id, r]) => [id, r.total]));

const seoulRows = await dayFiles<SeoulRow>("seoul_citydata", addDays(asOf, -7 * 8), asOf);
const seoulPlaces = await readJson<{ places: { areaCd: string; category: string }[] }>("data/sources/seoul/places.json", { places: [] });
const gg = await readJson<{ sigungu: Record<string, Record<string, number>> }>("data/sources/gg/pattern.json", { sigungu: {} });
const ggLink = await readJson<{ links: Record<string, string> }>("data/sources/gg/link.json", { links: {} });
const holidays = await readJson<{ holidays: Record<string, string> }>("data/sources/holidays.json", { holidays: {} });
const exposure = await readJson<ComputeInput["exposure"]>("data/state/exposure.json", {});

const out = compute(
  {
    asOf,
    places,
    cnctr: cnctr.sigungu,
    cnctrHistory,
    weekly,
    backfill,
    blogTotal,
    seoulRows,
    seoulCategory: Object.fromEntries(seoulPlaces.places.map((p) => [p.areaCd, p.category])),
    seoulCategoryMap: cat.seoulCategoryMap,
    gg: gg.sigungu,
    ggLink: ggLink.links,
    holidays: holidays.holidays,
    exposure,
  },
  cfg,
);

await writeJson("data/scores/places.json", { asOf, places: out.scores }, 0);
await writeJson("data/scores/patterns.json", { asOf, ...out.patterns }, 0);
for (const [date, rec] of Object.entries(out.recommendations)) await writeJson(`data/recommendations/${date}.json`, rec, 0);
// 지난 날짜 추천 파일은 지운다(이력은 git 에 남는다)
const recDir = "data/recommendations";
for (const f of await readdir(recDir)) if (/^\d{4}-\d{2}-\d{2}\.json$/.test(f) && f.slice(0, 10) < asOf) await rm(join(recDir, f));
await writeJson("data/state/exposure.json", out.exposure);
await writeJson("data/reports/coverage/latest.json", out.coverage);

// 화면용 공개 자료 → public-out/ (git 제외). 워크플로가 public-data 브랜치에 한 커밋으로 올린다
const regionsCfg = await yaml<{ travel: PublicInput["travel"] }>("config/regions.yaml");
const catCfg = await yaml<{ categories: { id: string; label: string }[] }>("config/categories.yaml");
const comp = await yaml<{ companions: PublicInput["companions"] }>("config/companions.yaml");
const sig = await readJson<{ sigungu: { code: string; name: string }[] }>("data/sources/regions/sigungu.json", { sigungu: [] });
const maxOf = (xs: (string | undefined)[]) => xs.filter((x): x is string => Boolean(x)).sort().at(-1) ?? null;
const pub = buildPublic({
  asOf,
  places,
  out,
  sigunguNames: Object.fromEntries(sig.sigungu.map((x) => [x.code, x.name])),
  categories: catCfg.categories,
  companions: comp.companions,
  travel: regionsCfg.travel,
  feed: cfg.feed,
  topN: cfg.exposure.topN,
  altRadiusKm: (cfg as unknown as { detail: { altRadiusKm: number } }).detail.altRadiusKm,
  updated: {
    forecast: maxOf(Object.values(cnctr.sigungu).map((x) => x.fetchedAt)),
    seoul: maxOf(seoulRows.map((r) => r.fetchedAt)),
    search: maxOf([...weekly.values()].map((r) => r.fetchedAt)),
  },
});
await rm("public-out", { recursive: true, force: true });
for (const [path, data] of Object.entries(pub)) await writeJson(join("public-out", path), data, 0);

const today = out.coverage.typesByDate[asOf];
console.log(JSON.stringify({ asOf, places: out.coverage.places, today, scores: { popularity: out.coverage.scores.popularity, trend: out.coverage.scores.trend, longTerm: out.coverage.scores.longTerm }, historyDays: new Set(historyRows.map((r) => r.date)).size }));
