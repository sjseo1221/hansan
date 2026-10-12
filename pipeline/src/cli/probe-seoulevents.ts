// 서울시 문화행사 정보(OA-15486, culturalEventInfo) 확인 — 정기 축제(예: 잠수교 뚜벅뚜벅 축제)가 있는지, 응답 필드는 무엇인지. 키는 출력하지 않는다
const key = process.env.SEOUL_OPENAPI_KEY;
if (!key) {
  console.error("SEOUL_OPENAPI_KEY 없음");
  process.exit(1);
}
const res = await fetch(`http://openapi.seoul.go.kr:8088/${encodeURIComponent(key)}/json/culturalEventInfo/1/1000/`, { signal: AbortSignal.timeout(30000) });
const text = await res.text();
let j: any;
try {
  j = JSON.parse(text);
} catch {
  console.log(JSON.stringify({ status: res.status, nonJson: text.slice(0, 200).replace(key, "***") }));
  process.exit(0);
}
const body = j.culturalEventInfo;
const rows: any[] = body?.row ?? [];
console.log(JSON.stringify({ status: res.status, result: body?.RESULT ?? j.RESULT, total: body?.list_total_count, fields: rows[0] ? Object.keys(rows[0]) : [] }));
const hit = rows.filter((r) => /잠수교|뚜벅/.test(`${r.TITLE} ${r.PLACE}`));
console.log(JSON.stringify({ match: hit.map((r) => ({ title: r.TITLE, codename: r.CODENAME, place: r.PLACE, date: r.DATE, strt: r.STRTDATE, end: r.END_DATE, gu: r.GUNAME, lat: r.LAT, lot: r.LOT, fee: r.IS_FREE })) }));
const kinds: Record<string, number> = {};
for (const r of rows) kinds[r.CODENAME] = (kinds[r.CODENAME] ?? 0) + 1;
console.log(JSON.stringify({ codename: kinds }));

// 제목으로 찾기(경로 순서: 분류/제목/날짜, 분류는 공백)
for (const t of ["뚜벅뚜벅", "잠수교"]) {
  const r2 = await fetch(`http://openapi.seoul.go.kr:8088/${encodeURIComponent(key)}/json/culturalEventInfo/1/20/%20/${encodeURIComponent(t)}/`, { signal: AbortSignal.timeout(30000) });
  const b2: any = JSON.parse(await r2.text()).culturalEventInfo;
  console.log(JSON.stringify({ title: t, total: b2?.list_total_count ?? 0, rows: (b2?.row ?? []).map((r: any) => ({ title: r.TITLE, codename: r.CODENAME, place: r.PLACE, date: r.DATE, gu: r.GUNAME, lat: r.LAT, lot: r.LOT, time: r.PRO_TIME })) }));
}

// 분류·날짜 필터 확인
for (const [label, path] of [
  ["분류 축제-문화/예술", `1/5/${encodeURIComponent("축제-문화/예술")}/`],
  ["분류 축제-관광/체육", `1/5/${encodeURIComponent("축제-관광/체육")}/`],
  ["날짜 2026-10-17", `1/5/%20/%20/2026-10-17`],
] as const) {
  const r3 = await fetch(`http://openapi.seoul.go.kr:8088/${encodeURIComponent(key)}/json/culturalEventInfo/${path}`, { signal: AbortSignal.timeout(30000) });
  const t3 = await r3.text();
  let b3: any = null;
  try { b3 = JSON.parse(t3).culturalEventInfo ?? JSON.parse(t3); } catch { b3 = { nonJson: t3.slice(0, 120) }; }
  console.log(JSON.stringify({ filter: label, total: b3?.list_total_count ?? null, result: b3?.RESULT ?? null, sample: (b3?.row ?? []).slice(0, 3).map((r: any) => [r.CODENAME, r.TITLE, r.DATE]) }));
}
