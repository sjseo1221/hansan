import { existsSync } from "node:fs";
import { loadSources } from "../lib/config.js";
import { readJson } from "../lib/store.js";
import { attemptedThisHour, collectSeoul, type Place } from "../collect/seoul.js";
import { exitCode } from "../lib/exit.js";

if (existsSync(".env")) process.loadEnvFile(".env");

const key = process.env.SEOUL_OPENAPI_KEY;
if (!key) {
  console.error("SEOUL_OPENAPI_KEY 가 없습니다. 로컬은 .env, 운영은 GitHub Secrets 에 넣으세요.");
  process.exit(1);
}

// GitHub 예약 실행과 Cloudflare Cron 이 같은 시간대에 겹쳐도 한 번만 시도한다.
// 성공이 아니라 '시도' 기준이라, 장애 중에도 중복 호출로 하루 상한이 소진되지 않는다. 강제 재수집은 FORCE=1
const now = new Date();
if (process.env.FORCE !== "1" && (await attemptedThisHour("data", now))) {
  console.log(JSON.stringify({ skipped: "이번 시간대 시도 완료" }));
  process.exit(0);
}

const { seoul_citydata: cfg } = await loadSources();
const { places } = await readJson<{ places: Place[] }>("data/sources/seoul/places.json", { places: [] });
const result = await collectSeoul({ places, cfg, key, dataDir: "data", now });

console.log(JSON.stringify(result));
process.exit(exitCode(result));
