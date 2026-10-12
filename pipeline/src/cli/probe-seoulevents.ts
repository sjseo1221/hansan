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
