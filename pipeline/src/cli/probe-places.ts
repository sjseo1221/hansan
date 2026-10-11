// 장소 목록 설계 사전 확인(P1~P5·P7) — 설계서 tasks/hansan-phase1-foundation/workers/claude-main/result.md 5.1절.
// 요약만 출력하고 인증키·요청 URL 은 출력하지 않는다.
import { existsSync } from "node:fs";

if (existsSync(".env")) process.loadEnvFile(".env");
const key = process.env.DATA_GO_KR_KEY;
if (!key) {
  console.error("DATA_GO_KR_KEY 가 없습니다.");
  process.exit(1);
}

const BASE = "https://apis.data.go.kr/B551011";
const common = { pageNo: "1", MobileOS: "ETC", MobileApp: "hansan", _type: "json" };

async function call(path: string, params: Record<string, string>) {
  const qs = new URLSearchParams({ ...common, ...params }).toString();
  const res = await fetch(`${BASE}${path}?serviceKey=${encodeURIComponent(key!)}&${qs}`, { signal: AbortSignal.timeout(30000) });
  const text = await res.text();
  try {
    const j = JSON.parse(text);
    const raw = j?.response?.body?.items?.item ?? [];
    const items: any[] = Array.isArray(raw) ? raw : raw ? [raw] : [];
    return { status: res.status, code: j?.response?.header?.resultCode, totalCount: j?.response?.body?.totalCount ?? null, items };
  } catch {
    return { status: res.status, code: "UNPARSEABLE", totalCount: null, items: [] as any[], head: text.slice(0, 160) };
  }
}

const out = (probe: string, o: object) => console.log(JSON.stringify({ probe, ...o }));

// P1 — 집중률 한 번에 받을 수 있는 건수
for (const n of ["1000", "10000"]) {
  const r = await call("/TatsCnctrRateService/tatsCnctrRatedList", { areaCd: "11", signguCd: "11110", numOfRows: n });
  out(`P1 numOfRows=${n}`, { status: r.status, code: r.code, totalCount: r.totalCount, received: r.items.length });
}

// P2 — 날짜 범위·정렬, 다른 시·도 코드 체계
{
  const r = await call("/TatsCnctrRateService/tatsCnctrRatedList", { areaCd: "11", signguCd: "11110", numOfRows: "1000" });
  const days = [...new Set(r.items.map((i) => i.baseYmd))].sort();
  const names = new Set(r.items.map((i) => i.tAtsNm));
  out("P2 종로 범위", { days: days.length, first: days[0], last: days.at(-1), attractions: names.size, firstRowYmd: r.items[0]?.baseYmd });
}
for (const [areaCd, signguCd, label] of [["51", "51110", "강원 춘천(51)"], ["42", "42110", "강원 춘천(42 옛 코드)"], ["36", "36110", "세종"], ["28", "28185", "인천 연수구"], ["28", "28110", "인천 중구(개편 전)"], ["41", "41111", "수원 장안구(일반구)"], ["41", "41110", "수원시"]]) {
  const r = await call("/TatsCnctrRateService/tatsCnctrRatedList", { areaCd, signguCd, numOfRows: "5" });
  out(`P2 ${label}`, { code: r.code, totalCount: r.totalCount, sample: r.items[0] ? { areaNm: r.items[0].areaNm, signguNm: r.items[0].signguNm, tAtsNm: r.items[0].tAtsNm } : null });
}

// P3 — 법정동 시·도 16건 목록, 시·도별 시·군·구
{
  const r = await call("/KorService2/ldongCode2", { numOfRows: "50" });
  out("P3 시도", { totalCount: r.totalCount, list: r.items.map((i) => `${i.code}:${i.name}`) });
  for (const regn of ["11", "28", "41", "51", "43", "44", "30", "36"]) {
    const s = await call("/KorService2/ldongCode2", { numOfRows: "100", lDongRegnCd: regn });
    out(`P3 시군구 ${regn}`, { code: s.code, totalCount: s.totalCount, sample: s.items.slice(0, 4).map((i) => `${i.code}:${i.name}`), keys: s.items[0] ? Object.keys(s.items[0]) : [] });
  }
}

// P4 — 지역·유형 필터 동작과 유형별 건수
for (const t of ["12", "14", "28", "38"]) {
  const r = await call("/KorService2/areaBasedList2", { numOfRows: "1000", arrange: "C", lDongRegnCd: "11", contentTypeId: t });
  const types = [...new Set(r.items.map((i) => i.contenttypeid))];
  const regns = [...new Set(r.items.map((i) => i.lDongRegnCd))];
  out(`P4 서울 유형 ${t}`, { code: r.code, totalCount: r.totalCount, received: r.items.length, typesInPage: types, regnsInPage: regns, lcls1: [...new Set(r.items.map((i) => i.lclsSystm1))] });
}

// P5 — 키워드 검색
{
  const r = await call("/KorService2/searchKeyword2", { numOfRows: "5", keyword: "가회민화박물관" });
  out("P5 키워드", { code: r.code, totalCount: r.totalCount, keys: r.items[0] ? Object.keys(r.items[0]) : [], titles: r.items.map((i) => i.title) });
}

// P7 — 신분류 체계
{
  const r = await call("/KorService2/lclsSystmCode2", { numOfRows: "50" });
  out("P7 대분류", { list: r.items.map((i) => `${i.code}:${i.name}`) });
  for (const c of r.items.map((i) => i.code)) {
    const s = await call("/KorService2/lclsSystmCode2", { numOfRows: "100", lclsSystm1: c });
    out(`P7 ${c}`, { count: s.totalCount, list: s.items.map((i) => `${i.code}:${i.name}`) });
  }
}
