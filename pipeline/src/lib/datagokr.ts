// 공공데이터포털(한국관광공사 B551011) 공통 호출. 인증키는 일반 인증키(Decoding)라 인코딩해서 보낸다(2026-10-11 probe 확인).
// 오류 메시지·기록에 인증키가 든 URL 을 남기지 않는다 (NFR-SEC-01)
export interface DgResult<T = any> {
  totalCount: number;
  items: T[];
}

export type DgGet = (path: string, params: Record<string, string>) => Promise<DgResult>;

export class DgError extends Error {
  constructor(public code: string) {
    super(code);
    this.name = code;
  }
}

// base·defaults 를 바꾸면 같은 포털의 다른 기관 API(기상청 1360000, 한국천문연구원 B090041)에도 쓴다
const KTO = { base: "https://apis.data.go.kr/B551011", defaults: { pageNo: "1", MobileOS: "ETC", MobileApp: "hansan", _type: "json" } };

export function datagokr(key: string, timeoutMs = 30000, api: { base: string; defaults: Record<string, string> } = KTO): DgGet {
  return async (path, params) => {
    const qs = new URLSearchParams({ ...api.defaults, ...params }).toString();
    let res: Response | undefined;
    // 연결 실패(TypeError: fetch failed)는 러너에 따라 일시적으로 난다(2026-10-12 build 9건 전부 실패, 같은 시각 probe 는 정상) — 한 번 더 시도한다.
    // 기록에는 원인 코드(UND_ERR_CONNECT_TIMEOUT 등)를 남긴다
    for (let attempt = 1; !res; attempt++) {
      try {
        res = await fetch(`${api.base}${path}?serviceKey=${encodeURIComponent(key)}&${qs}`, { signal: AbortSignal.timeout(timeoutMs) });
      } catch (e) {
        const err = e as Error & { cause?: { code?: string } };
        if (err.name === "TypeError" && attempt < 2) {
          await new Promise((r) => setTimeout(r, 3000));
          continue;
        }
        throw new DgError(err.name === "TypeError" ? `NET_${err.cause?.code ?? "FETCH_FAILED"}` : err.name || "FETCH_ERROR");
      }
    }
    const text = await res.text();
    let j: any;
    try {
      j = JSON.parse(text);
    } catch {
      // 인증·한도 오류는 XML 로 온다 — 사유 코드만 뽑는다
      throw new DgError(text.match(/<returnReasonCode>([^<]*)</)?.[1] ? `DG_${text.match(/<returnReasonCode>([^<]*)</)![1]}` : `HTTP_${res.status}`);
    }
    const code = j?.response?.header?.resultCode;
    // 관광공사는 '0000', 기상청·천문연은 '00' 이 정상. 기상청 '03'(NO_DATA)은 빈 결과로 본다
    if (code === "03") return { totalCount: 0, items: [] };
    // 인증·한도 오류는 JSON 으로도 온다(OpenAPI_ServiceResponse.cmmMsgHeader, 2026-10-12 확인) — 22 가 하루 한도 초과, 30 이 미등록 키
    const reason = j?.OpenAPI_ServiceResponse?.cmmMsgHeader?.returnReasonCode;
    if (code !== "0000" && code !== "00") throw new DgError(`DG_${code ?? reason ?? "NO_HEADER"}`);
    const raw = j?.response?.body?.items?.item ?? [];
    return { totalCount: Number(j?.response?.body?.totalCount ?? 0), items: Array.isArray(raw) ? raw : [raw] };
  };
}
