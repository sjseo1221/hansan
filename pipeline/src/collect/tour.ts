// TourAPI v2(KorService2) — 시·군·구 목록과 장소 후보 (FR-DATA-01). 2026-10-12 사전 확인:
// - ldongCode2: 시·도 16건(세종은 '36110' 하나로 옴), lDongRegnCd 로 시·군·구 목록(경기·충청은 시와 일반구가 함께 옴)
// - areaBasedList2: lDongRegnCd·contentTypeId 필터 동작, 한 페이지 최대 1,000건
import { join } from "node:path";
import type { DgGet } from "../lib/datagokr.js";
import { kstIso, kstParts } from "../lib/time.js";
import { appendJsonl, writeJson } from "../lib/store.js";
import type { DailyUsage } from "../lib/usage.js";
import type { SigunguCode } from "./cnctr.js";

export const SOURCE = "tour";
const PAGE = 1000;

export interface Candidate {
  contentid: string;
  contenttypeid: string;
  title: string;
  addr1: string;
  mapx: number;
  mapy: number;
  lDongRegnCd: string;
  lDongSignguCd: string;
  lclsSystm1: string;
  lclsSystm2: string;
  lclsSystm3: string;
  modifiedtime: string;
}

async function call(get: DgGet, usage: DailyUsage, path: string, params: Record<string, string>) {
  if (!usage.tryConsume()) throw Object.assign(new Error("하루 상한"), { name: "DAILY_CAP" });
  await usage.save();
  return get(path, params);
}

// 시·도 코드 목록 → 시·군·구 5자리 코드. 세종처럼 시·도 코드가 이미 5자리면 그대로 쓴다
export async function fetchSigungu(get: DgGet, usage: DailyUsage, provinces: string[]): Promise<SigunguCode[]> {
  const top = await call(get, usage, "/KorService2/ldongCode2", { numOfRows: "50" });
  const out: SigunguCode[] = [];
  for (const p of provinces) {
    const own = top.items.find((i) => String(i.code) === p || String(i.code).startsWith(p));
    if (own && String(own.code).length === 5) {
      out.push({ code: String(own.code), name: own.name });
      continue;
    }
    const r = await call(get, usage, "/KorService2/ldongCode2", { numOfRows: "200", lDongRegnCd: p });
    for (const i of r.items) out.push({ code: `${p}${i.code}`, name: i.name });
  }
  return out;
}

// 세종처럼 시·도 코드가 5자리(36110)로 오면 시·도 2자리 + 시·군·구 3자리로 나눠 다른 시·도와 같은 형식으로 맞춘다
const pick = (i: any): Candidate => {
  const regn = String(i.lDongRegnCd ?? "");
  return {
  contentid: String(i.contentid),
  contenttypeid: String(i.contenttypeid),
  title: i.title,
  addr1: i.addr1 ?? "",
  mapx: Number(i.mapx),
  mapy: Number(i.mapy),
  lDongRegnCd: regn.slice(0, 2),
  lDongSignguCd: regn.length === 5 ? regn.slice(2) : String(i.lDongSignguCd ?? ""),
  lclsSystm1: i.lclsSystm1 ?? "",
  lclsSystm2: i.lclsSystm2 ?? "",
  lclsSystm3: i.lclsSystm3 ?? "",
  modifiedtime: i.modifiedtime ?? "",
  };
};

// 시·도 × 콘텐츠 유형별 후보를 페이지 끝까지 받는다. keepLcls2 가 있으면 그 신분류(중분류)만 남긴다
export async function fetchCandidates(
  get: DgGet,
  usage: DailyUsage,
  regn: string,
  types: { contentTypeId: string; keepLcls2?: string[] }[],
): Promise<Candidate[]> {
  const out: Candidate[] = [];
  for (const t of types) {
    for (let page = 1; ; page++) {
      const r = await call(get, usage, "/KorService2/areaBasedList2", {
        numOfRows: String(PAGE),
        pageNo: String(page),
        arrange: "C",
        lDongRegnCd: regn,
        contentTypeId: t.contentTypeId,
      });
      for (const i of r.items) {
        const c = pick(i);
        if (!t.keepLcls2 || t.keepLcls2.includes(c.lclsSystm2)) out.push(c);
      }
      if (page * PAGE >= r.totalCount || r.items.length === 0) break;
    }
  }
  return out;
}

// 시·도별 후보 파일을 쓴다. 받기에 실패한 시·도는 직전 파일을 그대로 둔다 (FR-DATA-11)
export async function collectTour(input: {
  get: DgGet;
  usage: DailyUsage;
  provinces: string[];
  types: { contentTypeId: string; keepLcls2?: string[] }[];
  dataDir: string;
  now: Date;
}) {
  const { get, usage, provinces, types, dataDir, now } = input;
  const at = kstIso(now);
  const t = kstParts(now);
  const failPath = join(dataDir, "state", "failures", `${t.yyyy}-${t.mm}.jsonl`);
  const result = { sigungu: 0, provincesOk: 0, provincesFailed: 0, candidates: 0 };

  // 세종처럼 시·도 자체가 5자리 코드인 곳은 그 코드로 후보를 조회한다
  const regnParam = new Map<string, string>();
  try {
    const sigungu = await fetchSigungu(get, usage, provinces);
    for (const p of provinces) {
      const own = sigungu.filter((s) => s.code.startsWith(p));
      // 시·군·구가 하나뿐인 시·도(세종 36110)는 그 코드로 조회한다
      regnParam.set(p, own.length === 1 ? own[0].code : p);
    }
    await writeJson(join(dataDir, "sources", "regions", "sigungu.json"), { fetchedAt: at, source: "TourAPI ldongCode2", sigungu });
    result.sigungu = sigungu.length;
  } catch (e) {
    await appendJsonl(failPath, [{ at, source: "tour_ldong", code: (e as Error).name, message: "요청 실패" }]);
  }

  for (const regn of provinces) {
    try {
      const candidates = await fetchCandidates(get, usage, regnParam.get(regn) ?? regn, types);
      await writeJson(join(dataDir, "sources", "tour", "candidates", `${regn.slice(0, 2)}.json`), { fetchedAt: at, source: "TourAPI areaBasedList2", candidates });
      result.provincesOk++;
      result.candidates += candidates.length;
    } catch (e) {
      result.provincesFailed++;
      await appendJsonl(failPath, [{ at, source: SOURCE, regn, code: (e as Error).name, message: "요청 실패" }]);
    }
  }
  return result;
}
