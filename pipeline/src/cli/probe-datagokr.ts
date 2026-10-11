// 공공데이터포털 API 실호출 확인 도구 (RFP 6절: 응답 형식·한도는 추측하지 않고 실제 호출로 확인)
// 각 API 를 1~2회 호출해 상태·결과 코드·응답 구조만 출력한다. 인증키·요청 URL 은 출력하지 않는다.
import { existsSync } from "node:fs";

if (existsSync(".env")) process.loadEnvFile(".env");
const key = process.env.DATA_GO_KR_KEY;
if (!key) {
  console.error("DATA_GO_KR_KEY 가 없습니다.");
  process.exit(1);
}

const BASE = "https://apis.data.go.kr";
const common = { numOfRows: "3", pageNo: "1", MobileOS: "ETC", MobileApp: "hansan", _type: "json" };

const kst = new Date(Date.now() + 9 * 3600_000);
const ymd = (d: Date) => d.toISOString().slice(0, 10).replaceAll("-", "");
const today = ymd(kst);
const weekAgo = ymd(new Date(kst.getTime() - 7 * 86400_000));
const monthAgo = ymd(new Date(kst.getTime() - 35 * 86400_000));

interface Probe {
  name: string;
  path: string;
  params: Record<string, string>;
}

const probes: Probe[] = [
  { name: "집중률 예측(파라미터 최소)", path: "/B551011/TatsCnctrRateService/tatsCnctrRatedList", params: { ...common } },
  { name: "집중률 예측(서울 종로)", path: "/B551011/TatsCnctrRateService/tatsCnctrRatedList", params: { ...common, areaCd: "11", signguCd: "11110" } },
  { name: "지역별 방문자수(기초)", path: "/B551011/DataLabService/locgoRegnVisitrDDList", params: { ...common, startYmd: monthAgo, endYmd: weekAgo } },
  { name: "TourAPI v2 지역기반 목록", path: "/B551011/KorService2/areaBasedList2", params: { ...common, arrange: "C" } },
  { name: "TourAPI v2 법정동 코드", path: "/B551011/KorService2/ldongCode2", params: { ...common } },
  { name: "TourAPI v2 분류 코드", path: "/B551011/KorService2/lclsSystmCode2", params: { ...common } },
  { name: "TourAPI v2 행사 검색", path: "/B551011/KorService2/searchFestival2", params: { ...common, eventStartDate: today } },
  { name: "TourAPI v1 지역기반 목록", path: "/B551011/KorService1/areaBasedList1", params: { ...common, arrange: "C" } },
  { name: "기상청 단기예보", path: "/1360000/VilageFcstInfoService_2.0/getVilageFcst", params: { numOfRows: "3", pageNo: "1", dataType: "JSON", base_date: today, base_time: "0500", nx: "60", ny: "127" } },
  { name: "기상청 중기육상예보", path: "/1360000/MidFcstInfoService/getMidLandFcst", params: { numOfRows: "3", pageNo: "1", dataType: "JSON", regId: "11B00000", tmFc: `${today}0600` } },
  { name: "특일 공휴일", path: "/B090041/openapi/service/SpcdeInfoService/getRestDeInfo", params: { numOfRows: "3", pageNo: "1", _type: "json", solYear: today.slice(0, 4), solMonth: today.slice(4, 6) } },
];

function summarize(body: string) {
  try {
    const j = JSON.parse(body);
    const header = j?.response?.header ?? j?.header ?? null;
    const items = j?.response?.body?.items?.item ?? j?.response?.body?.items ?? null;
    const first = Array.isArray(items) ? items[0] : items;
    return {
      format: "json",
      header,
      totalCount: j?.response?.body?.totalCount ?? null,
      itemKeys: first && typeof first === "object" ? Object.keys(first) : null,
      sample: first ?? null,
    };
  } catch {
    const pick = (tag: string) => body.match(new RegExp(`<${tag}>([^<]*)</${tag}>`))?.[1] ?? null;
    return { format: "xml/text", returnAuthMsg: pick("returnAuthMsg"), returnReasonCode: pick("returnReasonCode"), resultCode: pick("resultCode"), resultMsg: pick("resultMsg"), head: body.slice(0, 200) };
  }
}

for (const p of probes) {
  // 일반 인증키(Decoding)를 넣었으면 인코딩이 필요하고, Encoding 키를 넣었으면 그대로 써야 한다 — 둘 다 시도
  for (const mode of ["encoded", "raw"] as const) {
    const qs = new URLSearchParams(p.params).toString();
    const k = mode === "encoded" ? encodeURIComponent(key) : key;
    let out: unknown;
    try {
      const res = await fetch(`${BASE}${p.path}?serviceKey=${k}&${qs}`, { signal: AbortSignal.timeout(20000) });
      out = { status: res.status, ...summarize(await res.text()) };
    } catch (e) {
      out = { error: (e as Error).name };
    }
    console.log(JSON.stringify({ probe: p.name, path: p.path, keyMode: mode, ...(out as object) }));
    const s = JSON.stringify(out);
    if (!/SERVICE_KEY|INVALID_REQUEST_PARAMETER_ERROR|등록되지 않은/i.test(s)) break;
  }
}
