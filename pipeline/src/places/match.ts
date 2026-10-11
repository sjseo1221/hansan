// 집중률 관광지 이름 ↔ TourAPI 후보 매칭 (설계서 3절, 2026-10-12 사전 확인으로 조정).
// 인천은 집중률이 개편 전 구 코드, TourAPI 가 개편 후 코드를 써서 코드로는 연결할 수 없다.
// 그래서 범위를 '같은 시·도 + 주소에 시·군·구 이름이 들어 있는 후보'로 잡고, 없으면 시·도 전체에서 정확·정규화 일치만 본다.
import type { Attraction } from "../collect/cnctr.js";
import type { Candidate } from "../collect/tour.js";

export type Method = "manual" | "exact" | "normalized" | "partial";
export type Confidence = "high" | "medium" | "low";

export interface Match {
  attraction: Attraction;
  candidate: Candidate;
  method: Method;
  confidence: Confidence;
  ambiguous: boolean;
}

const ENT: Record<string, string> = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'" };

export function norm(s: string): string {
  return s
    .normalize("NFC")
    .replace(/&(amp|lt|gt|quot|#39);/g, (m) => ENT[m])
    .replace(/\([^)]*\)|\[[^\]]*\]|（[^）]*）/g, "")
    .replace(/[\s·・\-_,.'"]/g, "")
    .toLowerCase();
}

export const MIN_PARTIAL = 3;

// 같은 이름 후보가 여럿이면 콘텐츠 유형 우선순위 → 최근 수정 순으로 하나를 고른다
function pickOne(cands: Candidate[], typePriority: string[]): Candidate {
  const rank = (c: Candidate) => {
    const i = typePriority.indexOf(c.contenttypeid);
    return i < 0 ? typePriority.length : i;
  };
  return [...cands].sort((a, b) => rank(a) - rank(b) || b.modifiedtime.localeCompare(a.modifiedtime))[0];
}

// 주소에 시·군·구 이름이 들어 있는지 — "수원시 장안구" 처럼 띄어 쓴 일반구도 그대로 비교한다
const inSigungu = (c: Candidate, a: Attraction) => c.addr1.includes(a.signguNm);

export function matchOne(
  a: Attraction,
  byProvince: Map<string, Candidate[]>,
  opts: { typePriority: string[]; manual?: Map<string, string | null>; byId?: Map<string, Candidate> },
): Match | null {
  const key = `${a.signguCd}|${a.tAtsNm}`;
  if (opts.manual?.has(key)) {
    const id = opts.manual.get(key);
    const c = id ? opts.byId?.get(id) : undefined;
    // null 은 '매칭하지 않음'(오매칭 차단)
    return c ? { attraction: a, candidate: c, method: "manual", confidence: "high", ambiguous: false } : null;
  }
  const province = byProvince.get(a.areaCd) ?? [];
  const local = province.filter((c) => inSigungu(c, a));
  const n = norm(a.tAtsNm);

  for (const pool of [local, province]) {
    const exact = pool.filter((c) => c.title === a.tAtsNm);
    const normalized = exact.length ? exact : pool.filter((c) => norm(c.title) === n);
    const method: Method = exact.length ? "exact" : "normalized";
    if (normalized.length === 1) {
      return { attraction: a, candidate: normalized[0], method, confidence: pool === local ? "high" : "medium", ambiguous: false };
    }
    if (normalized.length > 1) {
      return { attraction: a, candidate: pickOne(normalized, opts.typePriority), method, confidence: "medium", ambiguous: true };
    }
    // 포함 관계는 시·군·구 안에서만, 짧은 쪽이 MIN_PARTIAL 자 이상이고 후보가 정확히 1건일 때만
    if (pool === local) {
      const partial = local.filter((c) => {
        const m = norm(c.title);
        const [short, long] = m.length <= n.length ? [m, n] : [n, m];
        return short.length >= MIN_PARTIAL && long.includes(short);
      });
      if (partial.length === 1) return { attraction: a, candidate: partial[0], method: "partial", confidence: "low", ambiguous: false };
    }
  }
  return null;
}
