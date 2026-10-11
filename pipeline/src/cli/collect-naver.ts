import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { parse } from "yaml";
import { readJson } from "../lib/store.js";
import { collectBlog, collectTrend, type NaverConfig, type PlaceRef } from "../collect/naver.js";

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
const places = (await readJson<{ places: (PlaceRef & { hidden?: boolean })[] }>(PLACES, { places: [] })).places.filter((p) => !p.hidden);

const cfg = (parse(await readFile("config/sources.yaml", "utf8")) as { naver: NaverConfig }).naver;
const ctx = { places, cfg, auth: { id, secret }, dataDir: "data", now: new Date() };
const blog = await collectBlog(ctx);
const trend = await collectTrend(ctx);
console.log(JSON.stringify({ blog, trend }));

// 한 곳도 못 받았으면 실패로 끝내 저장소 알림이 가게 한다 (FR-OPS-04)
if ((blog.attempted > 0 && blog.ok === 0) || (trend.places > 0 && trend.ok === 0 && trend.skipped < trend.places)) process.exit(1);
