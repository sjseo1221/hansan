// 경기 유동인구 CSV 가져오기 (FR-DATA-05, 1회성). 사용: data/sources/gg/ 아래(하위 폴더 포함)에 압축을 푼 CSV 를 두고 `npm run import:gg`
// 원본 CSV 는 커밋하지 않는다(용량) — 시간대 패턴 결과만 커밋한다. 인코딩이 EUC-KR 이면 UTF-8 로 바꿔 둔다.
import { createReadStream, existsSync, readdirSync } from "node:fs";
import { basename } from "node:path";
import { createInterface } from "node:readline";
import { PatternBuilder } from "../collect/gg-population.js";
import { readJson, writeJson } from "../lib/store.js";
import type { Place } from "../places/build.js";

const dir = "data/sources/gg";
// 파일 이름 T22_GG_ADMI_FLOWPOP_<YYYYMM>_<시군>.csv — 월은 파일 이름에만 있다
const csvs = existsSync(dir) ? (readdirSync(dir, { recursive: true }) as string[]).filter((f) => /_\d{6}_[^_]+\.csv$/i.test(f)).sort() : [];
if (!csvs.length) {
  console.error(`CSV 가 없습니다. 경기데이터드림 '유동인구_행정동 단위 집계' zip 을 받아 ${dir}/ 에 압축을 푸세요.`);
  process.exit(1);
}

const builder = new PatternBuilder();
for (const f of csvs) {
  const lines: string[] = [];
  for await (const l of createInterface({ input: createReadStream(`${dir}/${f}`, "utf8"), crlfDelay: Infinity })) lines.push(l);
  builder.add(lines, basename(f).match(/_(\d{6})_/)![1]);
}
const pattern = builder.result(`경기데이터드림 유동인구_행정동 단위 집계 (${csvs.length}개 파일)`);
await writeJson(`${dir}/pattern.json`, pattern);

// 경기 장소와 시·군·구 패턴 연결 — 행정동 연결은 좌표→행정동 경계 자료가 필요해 아직 하지 않는다(SRS 9절 행정동 미확보)
const { places } = await readJson<{ places: Place[] }>("data/places/places.json", { places: [] });
const gg = places.filter((p) => p.region.provinceCd === "41");
const linked = gg.filter((p) => pattern.sigungu[p.region.signguCd]);
await writeJson(`${dir}/link.json`, {
  source: pattern.source,
  level: "sigungu",
  note: "장소 → 시·군·구 시간대 패턴 연결. 행정동 단위 연결은 경계 자료 확보 후",
  links: Object.fromEntries(linked.map((p) => [p.placeId, p.region.signguCd])),
  unlinked: gg.filter((p) => !pattern.sigungu[p.region.signguCd]).map((p) => ({ placeId: p.placeId, signguCd: p.region.signguCd })),
});
console.log(JSON.stringify({ files: csvs.length, skippedRows: pattern.skippedRows, months: pattern.months, slots: pattern.slots.length, adminDong: Object.keys(pattern.adminDong).length, sigungu: Object.keys(pattern.sigungu).length, ggPlaces: gg.length, linked: linked.length }));
