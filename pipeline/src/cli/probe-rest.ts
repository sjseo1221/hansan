// 남은 수집기(FR-DATA-03·08·09) 구현 전 실호출 확인 — 요약만 출력, 인증키·URL 미출력
import { existsSync } from "node:fs";

if (existsSync(".env")) process.loadEnvFile(".env");
const key = process.env.DATA_GO_KR_KEY!;
const kst = new Date(Date.now() + 9 * 3600_000);
const ymd = (d: Date) => d.toISOString().slice(0, 10).replaceAll("-", "");
const today = ymd(kst);
const daysAgo = (n: number) => ymd(new Date(kst.getTime() - n * 86400_000));

async function call(base: string, path: string, params: Record<string, string>) {
  const qs = new URLSearchParams(params).toString();
  const res = await fetch(`${base}${path}?serviceKey=${encodeURIComponent(key)}&${qs}`, { signal: AbortSignal.timeout(30000) });
  const text = await res.text();
  try {
    const j = JSON.parse(text);
    const raw = j?.response?.body?.items?.item ?? [];
    return { code: j?.response?.header?.resultCode, total: j?.response?.body?.totalCount, items: (Array.isArray(raw) ? raw : [raw]) as any[] };
  } catch {
    return { code: "UNPARSEABLE", total: null, items: [] as any[], head: text.slice(0, 160) };
  }
}
const out = (probe: string, o: object) => console.log(JSON.stringify({ probe, ...o }));
const KTO = "https://apis.data.go.kr/B551011";
const kto = { MobileOS: "ETC", MobileApp: "hansan", _type: "json", pageNo: "1" };

// FR-DATA-03 지역별 방문자수: 최신 날짜와 한 번에 받을 수 있는 양
{
  const r = await call(KTO, "/DataLabService/locgoRegnVisitrDDList", { ...kto, numOfRows: "10000", startYmd: daysAgo(45), endYmd: daysAgo(1) });
  const days = [...new Set(r.items.map((i) => i.baseYmd))].sort();
  out("방문자수 45일", { code: r.code, total: r.total, received: r.items.length, firstDay: days[0], lastDay: days.at(-1), days: days.length, touDiv: [...new Set(r.items.map((i) => `${i.touDivCd}:${i.touDivNm}`))], sigungu: new Set(r.items.map((i) => i.signguCode)).size });
}

// FR-DATA-08 행사: 지역 필터·기간 의미
for (const p of [{ eventStartDate: today }, { eventStartDate: today, lDongRegnCd: "11" }] as Record<string, string>[]) {
  const r = await call(KTO, "/KorService2/searchFestival2", { ...kto, numOfRows: "1000", arrange: "C", ...p });
  const starts = r.items.map((i) => i.eventstartdate).sort();
  const ends = r.items.map((i) => i.eventenddate).sort();
  out(`행사 ${JSON.stringify(p)}`, { code: r.code, total: r.total, received: r.items.length, minStart: starts[0], maxStart: starts.at(-1), minEnd: ends[0], regns: [...new Set(r.items.map((i) => i.lDongRegnCd))].slice(0, 20) });
}

// FR-DATA-09 운영 정보: 콘텐츠 유형별 detailIntro2 필드
for (const [contentId, contentTypeId] of [["126508", "12"], ["129703", "14"], ["", "28"], ["", "15"], ["", "38"]]) {
  let id = contentId;
  if (!id) {
    const l = await call(KTO, "/KorService2/areaBasedList2", { ...kto, numOfRows: "1", lDongRegnCd: "11", contentTypeId });
    id = String(l.items[0]?.contentid ?? "");
  }
  const r = await call(KTO, "/KorService2/detailIntro2", { ...kto, numOfRows: "1", contentId: id, contentTypeId });
  const it = r.items[0] ?? {};
  out(`운영정보 유형 ${contentTypeId}`, { code: r.code, contentId: id, fields: Object.fromEntries(Object.entries(it).filter(([k]) => /rest|use|open|time|date|hour|close|play|spend/i.test(k)).map(([k, v]) => [k, String(v).slice(0, 60)])) });
}

// 기상청 단기예보: 한 지점 3일치가 한 번에 오는지
{
  const r = await call("https://apis.data.go.kr/1360000", "/VilageFcstInfoService_2.0/getVilageFcst", { numOfRows: "1000", pageNo: "1", dataType: "JSON", base_date: today, base_time: "0500", nx: "60", ny: "127" });
  out("단기예보 1지점", { code: r.code, total: r.total, received: r.items.length, dates: [...new Set(r.items.map((i) => i.fcstDate))], categories: [...new Set(r.items.map((i) => i.category))] });
}
// 기상청 중기기온
{
  const r = await call("https://apis.data.go.kr/1360000", "/MidFcstInfoService/getMidTa", { numOfRows: "10", pageNo: "1", dataType: "JSON", regId: "11B10101", tmFc: `${today}0600` });
  out("중기기온 서울", { code: r.code, keys: r.items[0] ? Object.keys(r.items[0]).slice(0, 12) : [] });
}
