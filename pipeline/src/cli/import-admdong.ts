// 행정동 경계 가져오기(FR-DATA-05) — 경기 장소를 소속 행정동의 유동인구 패턴에 잇기 위해 좌표 → 행정동을 찾는다.
// 출처: 통계청 SGIS 행정구역 경계(공공누리 1유형) 를 가공한 vuski/admdongkor (CC BY 4.0) — 두 출처를 모두 표시한다(docs/sources.md, 화면 하단).
// 경기도(시도 41)만 잘라 좌표를 소수 5자리(약 1m)로 줄여 data/sources/regions/admdong-41.json 에 둔다. 행정동 코드는 행정안전부 10자리의 앞 8자리
// (= 경기 유동인구 ADMI_CD, 2026-10-12 광명1동 41210510 으로 대조).
import { writeJson } from "../lib/store.js";

const VERSION = process.env.ADMDONG_VERSION ?? "ver20260701";
const URL = `https://raw.githubusercontent.com/vuski/admdongkor/master/${VERSION}/HangJeongDong_${VERSION}.geojson`;

type Ring = [number, number][];
interface Feature {
  properties: { adm_nm: string; adm_cd2: string; sgg: string; sido: string };
  geometry: { type: "Polygon"; coordinates: Ring[] } | { type: "MultiPolygon"; coordinates: Ring[][] };
}

const res = await fetch(URL, { signal: AbortSignal.timeout(120000) });
if (!res.ok) {
  console.error(`행정동 경계를 받지 못함: HTTP ${res.status}`);
  process.exit(1);
}
const geo = (await res.json()) as { features: Feature[] };
const r5 = (x: number) => Math.round(x * 1e5) / 1e5;
const features = geo.features
  .filter((f) => f.properties.sido === "41")
  .map((f) => {
    const polys = (f.geometry.type === "Polygon" ? [f.geometry.coordinates] : f.geometry.coordinates).map((poly) => poly.map((ring) => ring.map(([x, y]) => [r5(x), r5(y)] as [number, number])));
    const xs = polys.flat(2).map((p) => p[0]);
    const ys = polys.flat(2).map((p) => p[1]);
    return {
      code: f.properties.adm_cd2.slice(0, 8),
      name: f.properties.adm_nm,
      sgg: f.properties.sgg,
      bbox: [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)],
      polys,
    };
  })
  .sort((a, b) => (a.code < b.code ? -1 : 1));
if (features.length < 500) {
  console.error(`경기 행정동이 너무 적음(${features.length}) — 파일 형식이 바뀌었는지 확인`);
  process.exit(1);
}
await writeJson(
  "data/sources/regions/admdong-41.json",
  { source: `통계청 SGIS 행정구역 경계 · vuski/admdongkor ${VERSION} (CC BY 4.0)`, url: URL, fetchedAt: new Date().toISOString(), features },
  0,
);
console.log(JSON.stringify({ version: VERSION, features: features.length }));
