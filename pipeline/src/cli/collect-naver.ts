import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { parse } from "yaml";
import { readJson } from "../lib/store.js";
import { exitCode } from "../lib/exit.js";
import { collectBlog, collectTrend, weekdayBucket, type NaverConfig, type PlaceRef } from "../collect/naver.js";

if (existsSync(".env")) process.loadEnvFile(".env");

const id = process.env.NAVER_CLIENT_ID;
const secret = process.env.NAVER_CLIENT_SECRET;
if (!id || !secret) {
  console.error("NAVER_CLIENT_ID / NAVER_CLIENT_SECRET 이 없습니다. 로컬은 .env, 운영은 GitHub Secrets 에 넣으세요.");
  process.exit(1);
}

// 장소 목록이 아직 없으면 실패가 아니라 건너뛴다(목록은 장소 목록 작업이 만든다)
const PLACES = "data/places/places.json";
if (!existsSync(PLACES)) {
  console.log(JSON.stringify({ skipped: "장소 목록 없음", path: PLACES }));
  process.exit(0);
}
// 숨김 장소는 다음 주기 작업부터 제외한다 (FR-DATA-13)
// 이월(stale) 장소도 뺀다 — 다시 매칭되지 않은 옛 장소에 호출을 쓰지 않게
const all = (await readJson<{ places: (PlaceRef & { hidden?: boolean; stale?: boolean })[] }>(PLACES, { places: [] })).places.filter((p) => !p.hidden && !p.stale);
// 오늘(KST 요일) 묶음만 수집한다. ALL=1 이면 전부(수동 점검용)
const now = new Date();
const today = new Date(now.getTime() + 9 * 3600_000).getUTCDay();
const cfg = (parse(await readFile("config/sources.yaml", "utf8")) as { naver: NaverConfig }).naver;
const bucket = all.filter((p) => weekdayBucket(p.placeId) === today);
// 따라잡기: 최근 14일 안에 주 단위 트렌드를 한 번도 못 받은 장소를 오늘 묶음 뒤에 하루 트렌드 상한까지 붙인다
// (수집을 막 시작했을 때 전 장소 인기도가 7일 기다리지 않고 2~3일 안에 채워지게, 2026-10-12)
const have = new Set<string>();
const trendDir = "data/raw/naver_trend";
const since = new Date(now.getTime() + 9 * 3600_000 - 14 * 86400_000).toISOString().slice(0, 10);
if (existsSync(trendDir))
  for (const f of await readdir(trendDir)) {
    if (!/^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f) || f.slice(0, 10) < since) continue;
    for (const l of (await readFile(`${trendDir}/${f}`, "utf8")).split("\n")) if (l.trim()) have.add((JSON.parse(l) as { placeId: string }).placeId);
  }
const inBucket = new Set(bucket.map((p) => p.placeId));
const missing = all.filter((p) => !have.has(p.placeId) && !inBucket.has(p.placeId)).sort((a, b) => (a.placeId < b.placeId ? -1 : 1));
// 같은 날 다시 돌면 오늘 이미 받은 장소는 빼고 따라잡기에만 쓴다(호출 낭비 방지)
const todayFile = `${trendDir}/${new Date(now.getTime() + 9 * 3600_000).toISOString().slice(0, 10)}.jsonl`;
const doneToday = new Set<string>();
if (existsSync(todayFile)) for (const l of (await readFile(todayFile, "utf8")).split("\n")) if (l.trim()) doneToday.add((JSON.parse(l) as { placeId: string }).placeId);
const todo = bucket.filter((p) => !doneToday.has(p.placeId));
const places = process.env.ALL === "1" ? all : [...todo, ...missing.slice(0, Math.max(0, cfg.trendDailyCap - todo.length))];
const ctx = { places, cfg, auth: { id, secret }, dataDir: "data", now };
const blog = await collectBlog(ctx);
const trend = await collectTrend(ctx);
console.log(JSON.stringify({ bucket: today, places: places.length, bucketSize: bucket.length, catchUp: places.length - bucket.length, missingBefore: missing.length, of: all.length, blog, trend }));

// 블로그와 트렌드를 각각 판정한다 — 한쪽만 죽어도 알림이 가게 (FR-OPS-04)
process.exit(Math.max(exitCode(blog), exitCode(trend)));
