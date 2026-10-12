// 한국관광공사 관광지 집중률 예측 매일 수집 (FR-DATA-02). 2026-10-12 사전 확인:
// - 시·군·구 단위 호출, numOfRows=10000 이면 한 번에 전부(종로 3,390건 = 관광지 34 × 30일)
// - 경기·충청은 일반구 코드, 인천은 개편 전 코드로 응답 → 응답하는 코드만 '활성'으로 기록해 다음부터 그 코드만 부른다
// 저장: 최신 30일 예측은 덮어쓰고(data/latest/cnctr.json), 이력은 '오늘 날짜 예측'만 누적한다(평소 혼잡 계산용, 착수 계획서 B-5)
import { join } from "node:path";
import type { DgGet } from "../lib/datagokr.js";
import { readFile } from "node:fs/promises";
import { appendJsonl, readJson, writeJson, writeLines } from "../lib/store.js";
import { kstIso, kstParts } from "../lib/time.js";
import { DailyUsage } from "../lib/usage.js";

export const SOURCE = "cnctr";
export const MAX_CONSECUTIVE_FAILURES = 10;

export interface SigunguCode {
  code: string; // 5자리 (시·도 2 + 시·군·구 3)
  name: string;
}

export interface CnctrConfig {
  dailyCap: number;
}

export interface Attraction {
  areaCd: string;
  signguCd: string;
  signguNm: string;
  tAtsNm: string;
  firstSeen: string;
  lastSeen: string;
}

interface SigunguForecast {
  areaCd: string;
  areaNm: string;
  signguCd: string;
  signguNm: string;
  // 관광지 이름 → 날짜(yyyymmdd) → 집중률(%)
  attractions: Record<string, Record<string, number>>;
  fetchedAt: string;
}

interface Latest {
  updatedAt?: string;
  source?: string;
  sigungu: Record<string, SigunguForecast>;
}

export async function collectCnctr(input: { candidates: SigunguCode[]; cfg: CnctrConfig; get: DgGet; dataDir: string; now: Date }) {
  const { candidates, cfg, get, dataDir, now } = input;
  if (candidates.length === 0) throw new Error("집중률 시·군·구 후보가 비어 있음");
  const t = kstParts(now);
  const at = kstIso(now);
  const today = `${t.yyyy}${t.mm}${t.dd}`;

  // 응답이 없던 코드는 주 1회만 다시 확인한다(개편으로 새로 생길 수 있어서)
  const activePath = join(dataDir, "state", "cnctr_codes.json");
  // 빈 응답 연속 2회째에 비활성으로 둔다 — 일시적 빈 응답 한 번으로 일주일 빠지지 않게(2차 리뷰)
  const known = await readJson<Record<string, { active: boolean; checkedOn: string; emptyStreak?: number }>>(activePath, {});
  const weekday = new Date(now.getTime() + 9 * 3600_000).getUTCDay();
  const targets = candidates.filter((c) => known[c.code]?.active !== false || weekday === 1);

  const usage = await DailyUsage.load(dataDir, SOURCE, t.date, cfg.dailyCap);
  const latestPath = join(dataDir, "latest", `${SOURCE}.json`);
  const latest = await readJson<Latest>(latestPath, { sigungu: {} });
  const attrPath = join(dataDir, "sources", "cnctr", "attractions.json");
  const attractions = await readJson<{ attractions: Attraction[] }>(attrPath, { attractions: [] });
  const attrIndex = new Map(attractions.attractions.map((a) => [`${a.signguCd}|${a.tAtsNm}`, a]));
  const failPath = join(dataDir, "state", "failures", `${t.yyyy}-${t.mm}.jsonl`);

  let ok = 0;
  let empty = 0;
  let failed = 0;
  let skipped = 0;
  let aborted = 0;
  let streak = 0;
  const history: unknown[] = [];

  for (const [idx, c] of targets.entries()) {
    if (streak >= MAX_CONSECUTIVE_FAILURES) {
      aborted = targets.length - idx;
      break;
    }
    if (!usage.tryConsume()) {
      skipped++;
      continue;
    }
    await usage.save();
    try {
      const r = await get("/TatsCnctrRateService/tatsCnctrRatedList", { areaCd: c.code.slice(0, 2), signguCd: c.code, numOfRows: "10000" });
      streak = 0;
      // 1만 건 넘게 있어 잘렸으면 부분 결과로 직전 예측을 덮지 않는다
      if (r.totalCount > r.items.length) throw Object.assign(new Error("잘림"), { name: "TRUNCATED" });
      if (r.items.length === 0) {
        const wasActive = known[c.code]?.active === true;
        const emptyStreak = (known[c.code]?.emptyStreak ?? 0) + 1;
        known[c.code] = { active: wasActive && emptyStreak < 2, checkedOn: t.date, emptyStreak };
        empty++;
        // 잘 나오던 시·군·구가 비면 장애일 수 있어 실패로 기록·집계한다
        if (wasActive) {
          failed++;
          await appendJsonl(failPath, [{ at, source: SOURCE, signguCd: c.code, code: "EMPTY", message: `빈 응답 ${emptyStreak}회째` }]);
        }
        continue;
      }
      known[c.code] = { active: true, checkedOn: t.date, emptyStreak: 0 };
      const f: SigunguForecast = { areaCd: r.items[0].areaCd, areaNm: r.items[0].areaNm, signguCd: c.code, signguNm: r.items[0].signguNm, attractions: {}, fetchedAt: at };
      for (const it of r.items) {
        (f.attractions[it.tAtsNm] ??= {})[it.baseYmd] = Number(it.cnctrRate);
        const k = `${c.code}|${it.tAtsNm}`;
        const a = attrIndex.get(k);
        if (a) a.lastSeen = t.date;
        else attrIndex.set(k, { areaCd: f.areaCd, signguCd: c.code, signguNm: f.signguNm, tAtsNm: it.tAtsNm, firstSeen: t.date, lastSeen: t.date });
        if (it.baseYmd === today) history.push({ date: it.baseYmd, signguCd: c.code, tAtsNm: it.tAtsNm, cnctrRate: Number(it.cnctrRate), fetchedAt: at, source: SOURCE });
      }
      // 시·군·구 단위로 통째로 바꾼다 — 실패한 시·군·구는 직전 예측을 그대로 둔다 (FR-DATA-11)
      latest.sigungu[c.code] = f;
      ok++;
    } catch (e) {
      streak++;
      failed++;
      await appendJsonl(failPath, [{ at, source: SOURCE, signguCd: c.code, code: (e as Error).name, message: "요청 실패" }]);
    }
  }

  if (ok > 0) {
    latest.updatedAt = at;
    latest.source = "한국관광공사 관광지 집중률 방문자 추이 예측";
    await writeJson(latestPath, latest);
    await writeJson(attrPath, { source: latest.source, attractions: [...attrIndex.values()].sort((a, b) => (a.signguCd + a.tAtsNm).localeCompare(b.signguCd + b.tAtsNm)) });
  }
  // 이력은 날짜별 파일에 (날짜·시군구·관광지) 키로 합친다 — 같은 날 여러 번 돌아도 한 줄씩만 남는다(2차 리뷰: 3배 중복)
  if (history.length) {
    const hPath = join(dataDir, "raw", "cnctr_history", `${t.yyyy}-${t.mm}`, `${t.dd}.jsonl`);
    const merged = new Map<string, unknown>();
    for (const line of (await readFile(hPath, "utf8").catch(() => "")).split("\n").filter(Boolean)) {
      const h = JSON.parse(line);
      merged.set(`${h.signguCd}|${h.tAtsNm}`, h);
    }
    for (const h of history as { signguCd: string; tAtsNm: string }[]) merged.set(`${h.signguCd}|${h.tAtsNm}`, h);
    await writeLines(hPath, [...merged.values()]);
  }
  await writeJson(activePath, known);

  return { attempted: ok + empty + failed, ok, empty, failed, skipped, aborted, activeCodes: Object.values(known).filter((k) => k.active).length };
}
