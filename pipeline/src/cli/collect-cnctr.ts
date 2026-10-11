// 관광지 집중률 예측 매일 수집 (FR-DATA-02) — 시·군·구 후보 = TourAPI 시·군·구 목록 + regions.yaml 추가 후보
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { parse } from "yaml";
import { collectCnctr, type CnctrConfig, type SigunguCode } from "../collect/cnctr.js";
import { datagokr } from "../lib/datagokr.js";
import { exitCode } from "../lib/exit.js";
import { readJson } from "../lib/store.js";

if (existsSync(".env")) process.loadEnvFile(".env");
const key = process.env.DATA_GO_KR_KEY;
if (!key) {
  console.error("DATA_GO_KR_KEY 가 없습니다. 로컬은 .env, 운영은 GitHub Secrets 에 넣으세요.");
  process.exit(1);
}

const cfg = (parse(await readFile("config/sources.yaml", "utf8")) as { cnctr: CnctrConfig }).cnctr;
const regions = parse(await readFile("config/regions.yaml", "utf8")) as { provinces: { code: string }[]; cnctrExtraSigungu?: SigunguCode[] };
const targets = new Set(regions.provinces.map((p) => p.code));
const { sigungu } = await readJson<{ sigungu: SigunguCode[] }>("data/sources/regions/sigungu.json", { sigungu: [] });
if (sigungu.length === 0) {
  console.error("시·군·구 목록이 없습니다. build-places 를 먼저 실행하세요.");
  process.exit(1);
}
const candidates = [...sigungu.filter((s) => targets.has(s.code.slice(0, 2))), ...(regions.cnctrExtraSigungu ?? [])];

const result = await collectCnctr({ candidates, cfg, get: datagokr(key), dataDir: "data", now: new Date() });
console.log(JSON.stringify(result));
process.exit(exitCode(result));
