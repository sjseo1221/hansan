// 매일 점수 계산 (FR-SCORE · FR-TYPE). 수집 결과를 읽어 data/scores · data/recommendations · data/reports/coverage 를 쓴다.
// ASOF=YYYY-MM-DD 로 기준일을 고정할 수 있다(재현·시험). 없으면 오늘(KST)
import { existsSync } from "node:fs";
import { readdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { parse } from "yaml";
import type { Place } from "../places/build.js";
import { compute, type ComputeConfig, type ComputeInput } from "../score/compute.js";
import { buildPublic, type PublicInput } from "../score/public.js";
import { factsFor, loadFactContext, REASONS_PATH, REVIEWS_PATH, type ReasonCache, type ReviewCache } from "../llm/context.js";
import type { SeoulRow } from "../score/patterns.js";
import type { TrendRow } from "../score/place-scores.js";
import { addDays, latestBy } from "../score/stats.js";
import { findDong, type AdmDong } from "../shared/geo.js";
import { HUB_PATH, type HubFile } from "../collect/hub.js";
import { matchHub } from "../score/hub-match.js";
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
const byIdPlace = new Map(places.map((p) => [p.placeId, p]));
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
// 경기 유동인구(FR-DATA-05): 장소 좌표가 속한 행정동의 패턴을 쓰고, 그 행정동 자료가 없으면 시·군·구 패턴으로 대신한다
const gg = await readJson<{ sigungu: Record<string, Record<string, number>>; adminDong: Record<string, { name: string; pattern: Record<string, number> }> }>("data/sources/gg/pattern.json", { sigungu: {}, adminDong: {} });
const dongs = (await readJson<{ features: AdmDong[] }>("data/sources/regions/admdong-41.json", { features: [] })).features;
const ggPatterns: Record<string, Record<string, number>> = {};
for (const [k, v] of Object.entries(gg.sigungu)) ggPatterns[`s:${k}`] = v;
for (const [k, v] of Object.entries(gg.adminDong ?? {})) ggPatterns[`d:${k}`] = v.pattern;
const ggLink: Record<string, string> = {};
const placeDong: Record<string, string> = {};
for (const p of places) {
  if (p.region.provinceCd !== "41" || p.hidden || p.stale) continue;
  const d = findDong(p.lng, p.lat, dongs);
  if (d) placeDong[p.placeId] = d.name.split(" ").at(-1)!;
  if (d && ggPatterns[`d:${d.code}`]) ggLink[p.placeId] = `d:${d.code}`;
  else if (ggPatterns[`s:${p.region.signguCd}`]) ggLink[p.placeId] = `s:${p.region.signguCd}`;
}
const holidays = await readJson<{ holidays: Record<string, string> }>("data/sources/holidays.json", { holidays: {} });
const exposure = await readJson<ComputeInput["exposure"]>("data/state/exposure.json", {});
// 4단계 결과(없으면 빈 값): 후기 판정은 숨은 클래식 판정에, 근거 문장은 화면에 쓴다
const reviews = await readJson<ReviewCache>(REVIEWS_PATH, {});
const reasonCache = await readJson<ReasonCache>(REASONS_PATH, {});

// 추가 인기도 신호(FR-DATA-14): 티맵 내비 기반 시·군·구 중심 관광지 순위
const hub = await readJson<HubFile>(`data/${HUB_PATH}`, { baseYm: "", fetchedAt: "", source: "", sigungu: {} });
const hubMatch = matchHub(
  places.filter((p) => !p.hidden && !p.stale),
  Object.values(hub.sigungu).flatMap((s) => s.items),
);
const navRank = new Map([...hubMatch.ranks].map(([id, v]) => [id, v.rank]));

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
    gg: ggPatterns,
    ggLink,
    holidays: holidays.holidays,
    navRank,
    reviewVerdicts: Object.fromEntries(Object.entries(reviews).map(([id, r]) => [id, r.verdict])),
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

// 오늘 추천 기록(적중률 계산 원자료, FR-OPS-03) — 추천 파일은 지난 날짜를 지우므로 당일 것만 따로 남긴다.
// 그날 첫 실행만 남긴다 — 나중 실행은 당일 실측을 이미 본 뒤라 예측 적중률이 사후 일치율이 될 수 있다
const todayRec = out.recommendations[asOf];
const recLogPath = `data/state/rec-log/${asOf.slice(0, 7)}/${asOf.slice(8)}.json`;
if (todayRec && !existsSync(recLogPath))
  await writeJson(
    recLogPath,
    { date: asOf, at: new Date().toISOString(), items: todayRec.items.map((r) => ({ id: r.placeId, rep: r.representative, lh: r.likelihood, ...(byIdPlace.get(r.placeId)?.external.seoulAreaCd ? { seoul: byIdPlace.get(r.placeId)!.external.seoulAreaCd } : {}) })) },
    0,
  );

// 화면용 공개 자료 → public-out/ (git 제외). 워크플로가 public-data 브랜치에 한 커밋으로 올린다
const regionsCfg = await yaml<{ travel: PublicInput["travel"] }>("config/regions.yaml");
const catCfg = await yaml<{ categories: { id: string; label: string }[] }>("config/categories.yaml");
const comp = await yaml<{ companions: PublicInput["companions"] }>("config/companions.yaml");
const sig = await readJson<{ sigungu: { code: string; name: string }[] }>("data/sources/regions/sigungu.json", { sigungu: [] });
// 추천 항목별 근거 문장 — 같은 사실(해시)로 생성해 둔 문장이 있으면 쓴다(FR-LLM-07)
const fc = await loadFactContext();
const reasons: Record<string, string> = {};
for (const [k, v] of factsFor(out.recommendations, new Map(places.map((p) => [p.placeId, p])), fc)) {
  const r = reasonCache[v.hash]?.r;
  if (r) reasons[k] = r;
}
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
  holidays: holidays.holidays,
  reasons,
  reviews,
  placeDong,
  navYm: hub.baseYm,
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
console.log(JSON.stringify({ hub: { baseYm: hub.baseYm, ...hubMatch.stats, matched: navRank.size }, asOf, places: out.coverage.places, today, scores: { popularity: out.coverage.scores.popularity, trend: out.coverage.scores.trend, longTerm: out.coverage.scores.longTerm }, historyDays: new Set(historyRows.map((r) => r.date)).size }));
