// 추가 인기도 신호(FR-DATA-14): 한국관광공사 '기초지자체 중심 관광지 정보'(data.go.kr 15128559, 이용허락범위 제한 없음).
// 티맵 내비게이션 목적지 검색·이동 기준 시·군·구별 중심 관광지 상위 100곳과 순위(hubRank). 월 단위라 지난달 것을 한 달에 한 번 받는다.
// 2026-10-12 실호출 확인: LocgoHubTarService1/areaBasedList1, areaCd·signguCd·baseYm(YYYYMM), 필드 hubTatsNm·hubRank·mapX·mapY·hubCtgryLclsNm·hubCtgryMclsNm
import { join } from "node:path";
import type { DgGet } from "../lib/datagokr.js";
import { appendJsonl, readJson, writeJson } from "../lib/store.js";
import { kstIso, kstParts } from "../lib/time.js";
import type { DailyUsage } from "../lib/usage.js";

export interface HubItem {
  signguCd: string;
  name: string;
  rank: number;
  lat: number;
  lng: number;
  lcls: string;
  mcls: string;
}
export interface HubFile {
  baseYm: string;
  fetchedAt: string;
  source: string;
  sigungu: Record<string, { baseYm: string; items: HubItem[] }>;
}

export const HUB_PATH = "sources/tour/hub.json";

// 지난달(KST) YYYYMM
export function lastMonth(now: Date): string {
  const t = kstParts(now);
  const y = Number(t.yyyy);
  const m = Number(t.mm);
  return m === 1 ? `${y - 1}12` : `${y}${String(m - 1).padStart(2, "0")}`;
}

export async function collectHub(input: { get: DgGet; usage: DailyUsage; sigungu: { areaCd: string; signguCd: string }[]; dataDir: string; now: Date }) {
  const { get, usage, sigungu, dataDir, now } = input;
  const path = join(dataDir, HUB_PATH);
  const prev = await readJson<HubFile>(path, { baseYm: "", fetchedAt: "", source: "", sigungu: {} });
  const ym = lastMonth(now);
  const t = kstParts(now);
  const failPath = join(dataDir, "state", "failures", `${t.yyyy}-${t.mm}.jsonl`);
  const out: HubFile = { ...prev, sigungu: { ...prev.sigungu } };
  const result = { baseYm: ym, todo: 0, ok: 0, empty: 0, failed: 0, capped: false };
  // 이번 달에 이미 받은 시·군·구는 건너뛴다(한 달에 한 번) — 하루 상한에 걸리면 다음 날 이어서
  for (const s of sigungu) {
    if (out.sigungu[s.signguCd]?.baseYm === ym) continue;
    result.todo++;
    if (!usage.tryConsume()) {
      result.capped = true;
      break;
    }
    await usage.save();
    try {
      const r = await get("/LocgoHubTarService1/areaBasedList1", { numOfRows: "100", pageNo: "1", areaCd: s.areaCd, signguCd: s.signguCd, baseYm: ym });
      const items: HubItem[] = r.items
        .map((i: Record<string, string>) => ({
          signguCd: s.signguCd,
          name: String(i.hubTatsNm ?? ""),
          rank: Number(i.hubRank),
          lat: Number(i.mapY),
          lng: Number(i.mapX),
          lcls: String(i.hubCtgryLclsNm ?? ""),
          mcls: String(i.hubCtgryMclsNm ?? ""),
        }))
        .filter((i) => i.name && Number.isFinite(i.rank));
      // 빈 응답이면 직전 값을 지우지 않는다(FR-DATA-11)
      if (!items.length) {
        result.empty++;
        await appendJsonl(failPath, [{ at: kstIso(now), source: "tour_hub", signguCd: s.signguCd, code: "EMPTY", message: "빈 응답" }]);
        continue;
      }
      out.sigungu[s.signguCd] = { baseYm: ym, items };
      result.ok++;
    } catch (e) {
      result.failed++;
      await appendJsonl(failPath, [{ at: kstIso(now), source: "tour_hub", signguCd: s.signguCd, code: (e as Error).name, message: "요청 실패" }]);
    }
  }
  if (result.ok) {
    out.baseYm = ym;
    out.fetchedAt = kstIso(now);
    out.source = "한국관광공사 기초지자체 중심 관광지 정보(티맵 내비게이션 기반)";
    await writeJson(path, out, 0);
  }
  return result;
}
