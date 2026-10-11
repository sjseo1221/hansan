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

export function datagokr(key: string, timeoutMs = 30000): DgGet {
  return async (path, params) => {
    const qs = new URLSearchParams({ pageNo: "1", MobileOS: "ETC", MobileApp: "hansan", _type: "json", ...params }).toString();
    let res: Response;
    try {
      res = await fetch(`https://apis.data.go.kr/B551011${path}?serviceKey=${encodeURIComponent(key)}&${qs}`, { signal: AbortSignal.timeout(timeoutMs) });
    } catch (e) {
      throw new DgError((e as Error).name || "FETCH_ERROR");
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
    if (code !== "0000") throw new DgError(`DG_${code ?? "NO_HEADER"}`);
    const raw = j?.response?.body?.items?.item ?? [];
    return { totalCount: Number(j?.response?.body?.totalCount ?? 0), items: Array.isArray(raw) ? raw : [raw] };
  };
}
