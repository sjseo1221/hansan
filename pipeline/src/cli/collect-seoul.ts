import { existsSync } from "node:fs";
import { loadSources } from "../lib/config.js";
import { readJson } from "../lib/store.js";
import { collectSeoul, type Place } from "../collect/seoul.js";

if (existsSync(".env")) process.loadEnvFile(".env");

const key = process.env.SEOUL_OPENAPI_KEY;
if (!key) {
  console.error("SEOUL_OPENAPI_KEY 가 없습니다. 로컬은 .env, 운영은 GitHub Secrets 에 넣으세요.");
  process.exit(1);
}

const { seoul_citydata: cfg } = await loadSources();
const { places } = await readJson<{ places: Place[] }>("data/sources/seoul/places.json", { places: [] });
const result = await collectSeoul({ places, cfg, key, dataDir: "data", now: new Date() });

console.log(JSON.stringify(result));
// 한 곳도 못 받았으면 실패로 끝내 저장소 알림이 가게 한다 (FR-OPS-04)
if (result.attempted > 0 && result.ok === 0) process.exit(1);
