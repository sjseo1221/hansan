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

// 주소에 시·군·구 이름이 낱말 단위로 들어 있는지 — 부분 문자열이면 '동구'가 '남동구'·'성동구'에도 걸린다(2026-10-12 2차 리뷰).
// "수원시 장안구" 처럼 띄어 쓴 일반구는 낱말 열이 그대로 이어져 있어야 한다
export function inSigungu(addr: string, signguNm: string): boolean {
  const a = addr.split(/\s+/);
  const s = signguNm.split(/\s+/);
  for (let i = 0; i + s.length <= a.length; i++) if (s.every((w, j) => a[i + j] === w)) return true;
  return false;
}

// 이름 괄호 안의 지역 표기 — "백덕산(평창)" 의 '평창'. regionHeads 에 있는 지역명일 때만 지역 표기로 본다("풍물시장(2, 7일)" 은 아님)
const tagOf = (s: string, heads: Set<string>) => {
  const m = s.match(/\(([^)]*)\)|（([^）]*)）/);
  const tag = norm((m?.[1] ?? m?.[2] ?? "").trim());
  return tag && heads.has(tag) ? tag : null;
};

// 두 이름의 지역 표기가 서로 다른 곳을 가리키면 같은 장소가 아니다(괄호를 지우는 norm 이 이 구분을 없애므로 따로 본다)
function regionConflict(a: Attraction, c: Candidate, heads: Set<string>): boolean {
  const ta = tagOf(a.tAtsNm, heads);
  const tc = tagOf(c.title, heads);
  if (ta && tc) return ta !== tc;
  if (tc) return !a.signguNm.includes(tc) && !norm(a.signguNm).startsWith(tc);
  if (ta) return !c.addr1.includes(ta);
  return false;
}

export function matchOne(
  a: Attraction,
  byProvince: Map<string, Candidate[]>,
  opts: { typePriority: string[]; manual?: Map<string, string | null>; byId?: Map<string, Candidate>; regionHeads?: Set<string> },
): Match | null {
  const key = `${a.signguCd}|${a.tAtsNm}`;
  if (opts.manual?.has(key)) {
    const id = opts.manual.get(key);
    const c = id ? opts.byId?.get(id) : undefined;
    // null 은 '매칭하지 않음'(오매칭 차단)
    return c ? { attraction: a, candidate: c, method: "manual", confidence: "high", ambiguous: false } : null;
  }
  const heads = opts.regionHeads ?? new Set<string>();
  const province = (byProvince.get(a.areaCd) ?? []).filter((c) => !regionConflict(a, c, heads));
  const local = province.filter((c) => inSigungu(c.addr1, a.signguNm));
  const n = norm(a.tAtsNm);

  // 1) 같은 시·군·구(주소 낱말) 안: 원문 → 정규화 → 포함 관계
  const exact = local.filter((c) => c.title === a.tAtsNm);
  const normalized = exact.length ? exact : local.filter((c) => norm(c.title) === n);
  const method: Method = exact.length ? "exact" : "normalized";
  if (normalized.length === 1) return { attraction: a, candidate: normalized[0], method, confidence: "high", ambiguous: false };
  if (normalized.length > 1) return { attraction: a, candidate: pickOne(normalized, opts.typePriority), method, confidence: "medium", ambiguous: true };
  // 포함 관계는 짧은 쪽이 MIN_PARTIAL 자 이상이고 후보가 정확히 1건일 때만
  const partial = local.filter((c) => {
    const m = norm(c.title);
    const [short, long] = m.length <= n.length ? [m, n] : [n, m];
    return short.length >= MIN_PARTIAL && long.includes(short);
  });
  if (partial.length === 1) return { attraction: a, candidate: partial[0], method: "partial", confidence: "low", ambiguous: false };

  // 2) 시·도 전체: 원문이 정확히 같은 후보가 딱 1건일 때만. 정규화 일치는 인천만 허용 —
  //    인천은 집중률이 개편 전 구 코드·이름을 써서 주소 낱말이 맞지 않는다. 다른 시·도는 동명이 다른 군의 장소인 경우가 많다
  const pExact = province.filter((c) => c.title === a.tAtsNm);
  if (pExact.length === 1) return { attraction: a, candidate: pExact[0], method: "exact", confidence: "medium", ambiguous: false };
  if (pExact.length === 0 && a.areaCd === "28") {
    const pNorm = province.filter((c) => norm(c.title) === n);
    if (pNorm.length === 1) return { attraction: a, candidate: pNorm[0], method: "normalized", confidence: "medium", ambiguous: false };
  }
  return null;
}
