import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
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
const places = process.env.ALL === "1" ? all : all.filter((p) => weekdayBucket(p.placeId) === today);

const cfg = (parse(await readFile("config/sources.yaml", "utf8")) as { naver: NaverConfig }).naver;
const ctx = { places, cfg, auth: { id, secret }, dataDir: "data", now };
const blog = await collectBlog(ctx);
const trend = await collectTrend(ctx);
console.log(JSON.stringify({ bucket: today, places: places.length, of: all.length, blog, trend }));

// 블로그와 트렌드를 각각 판정한다 — 한쪽만 죽어도 알림이 가게 (FR-OPS-04)
process.exit(Math.max(exitCode(blog), exitCode(trend)));
