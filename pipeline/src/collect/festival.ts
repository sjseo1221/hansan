// 축제 모음(2026-10-12 사용자 요청: 잠수교 뚜벅뚜벅 축제 같은 정기 축제).
// 출처 세 가지를 같은 모양으로 합친다: TourAPI 행사(events.json) · 서울시 문화행사 정보(OA-15486, 축제 분류) · 운영자가 적는 정기 축제 파일.
// 축제는 혼잡 예측이 없고 원래 붐비므로 '한산' 추천이 아니라 '이 날 열리는 축제'로 따로 보여 준다
import { createHash } from "node:crypto";
import { join } from "node:path";
import { appendJsonl, readJson, writeJson } from "../lib/store.js";
import { kstIso, kstParts } from "../lib/time.js";
import type { DailyUsage } from "../lib/usage.js";

export interface Festival {
  id: string;
  src: "tour" | "seoul" | "manual";
  title: string;
  place: string;
  lat: number | null;
  lng: number | null;
  start: string; // YYYYMMDD
  end: string;
  weekdays?: number[]; // 0=일 … 6=토. 없으면 기간 내 매일
  time?: string;
  link?: string;
}

const WD = "일월화수목금토";

// "매주 일요일 13:00 ~ 21:00", "매주 토·일요일" → 요일 목록. 없으면 undefined(매일)
export function weekdaysOf(text: string | undefined | null): number[] | undefined {
  const m = (text ?? "").match(/매주\s*([일월화수목금토](?:요일)?(?:\s*[,·/및]\s*[일월화수목금토](?:요일)?)*)/);
  if (!m) return undefined;
  const days = [...new Set([...m[1].replace(/요일/g, "")].filter((c) => WD.includes(c)).map((c) => WD.indexOf(c)))].sort();
  return days.length ? days : undefined;
}

export const activeOn = (f: Festival, ymd: string, wd: number) => f.start <= ymd && ymd <= f.end && (!f.weekdays || f.weekdays.includes(wd));

const SEOUL_FESTIVAL_CODES = ["축제-문화/예술", "축제-관광/체육", "축제-시민화합", "축제-자연/경관", "축제-전통/역사", "축제-기타"];
const httpsLink = (u: unknown) => (typeof u === "string" && /^https?:\/\//.test(u.trim()) ? u.trim() : undefined);

// 서울시 문화행사 정보 — 축제 분류별로 받아(분류 필터 동작, 2026-10-12 확인) 오늘~horizon 과 겹치는 것만 남긴다
export async function collectSeoulFestivals(input: { key: string; usage: DailyUsage; dataDir: string; now: Date; horizonDays: number; fetchImpl?: typeof fetch }) {
  const f = input.fetchImpl ?? fetch;
  const today = kstParts(input.now).date.replaceAll("-", "");
  const until = kstParts(new Date(input.now.getTime() + input.horizonDays * 86400000)).date.replaceAll("-", "");
  const t = kstParts(input.now);
  const failPath = join(input.dataDir, "state", "failures", `${t.yyyy}-${t.mm}.jsonl`);
  const out: Festival[] = [];
  const result = { codes: 0, rows: 0, kept: 0, failed: 0, capped: false };
  for (const code of SEOUL_FESTIVAL_CODES) {
    if (!input.usage.tryConsume()) {
      result.capped = true;
      break;
    }
    await input.usage.save();
    try {
      // 서울 API 는 http(8088)만 지원(docs/ops.md 알려진 위험)
      const res = await f(`http://openapi.seoul.go.kr:8088/${encodeURIComponent(input.key)}/json/culturalEventInfo/1/1000/${encodeURIComponent(code)}/`, { signal: AbortSignal.timeout(30000) });
      const j = JSON.parse(await res.text());
      const body = j.culturalEventInfo;
      if (!body) {
        // INFO-200 = 해당 분류 자료 없음 — 실패가 아니다
        if (j.RESULT?.CODE === "INFO-200") continue;
        throw Object.assign(new Error("형식"), { name: j.RESULT?.CODE ?? "NO_BODY" });
      }
      result.codes++;
      for (const r of body.row ?? []) {
        result.rows++;
        const [s, e] = String(r.DATE ?? "").split("~").map((x: string) => x.trim().slice(0, 10).replaceAll("-", ""));
        if (!s || !e || e < today || s > until) continue;
        const lat = Number(r.LAT);
        const lng = Number(r.LOT);
        out.push({
          id: `seoul-${createHash("sha1").update(`${r.TITLE}|${s}`).digest("hex").slice(0, 12)}`,
          src: "seoul",
          title: String(r.TITLE),
          place: [r.GUNAME, r.PLACE].filter(Boolean).join(" "),
          lat: Number.isFinite(lat) && lat > 30 ? lat : null,
          lng: Number.isFinite(lng) && lng > 120 ? lng : null,
          start: s,
          end: e,
          weekdays: weekdaysOf(`${r.PRO_TIME ?? ""} ${r.DATE ?? ""}`),
          time: r.PRO_TIME ? String(r.PRO_TIME) : undefined,
          link: httpsLink(r.ORG_LINK) ?? httpsLink(r.HMPG_ADDR),
        });
        result.kept++;
      }
    } catch (e) {
      result.failed++;
      await appendJsonl(failPath, [{ at: kstIso(input.now), source: "seoul_events", code: (e as Error).name, message: "요청 실패" }]);
    }
  }
  // 다 실패하면 직전 파일을 둔다(FR-DATA-11)
  if (result.codes > 0) await writeJson(join(input.dataDir, "latest", "festivals-seoul.json"), { updatedAt: kstIso(input.now), source: "서울시 문화행사 정보(OA-15486)", from: today, until, festivals: out }, 0);
  return result;
}

const normT = (s: string) => s.replace(/\[[^\]]*\]|\([^)]*\)|\d{4}|제\s*\d+\s*회|[\s·\-_'"]/g, "").toLowerCase();
const km = (a: { lat: number; lng: number }, b: { lat: number; lng: number }) => {
  const r = Math.PI / 180;
  const h = Math.sin(((b.lat - a.lat) * r) / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(((b.lng - a.lng) * r) / 2) ** 2;
  return 12742 * Math.asin(Math.sqrt(h));
};

// 같은 축제가 여러 출처에 있으면 하나만 — 운영자 파일 > 서울 > TourAPI 순으로 남긴다. 이름이 같거나(정규화) 한쪽이 포함하고 1km 안이면 같은 축제
export function mergeFestivals(...lists: Festival[][]): Festival[] {
  const out: Festival[] = [];
  for (const list of lists)
    for (const f of list) {
      const n = normT(f.title);
      const dup = out.some((g) => {
        const m = normT(g.title);
        const same = n === m || (Math.min(n.length, m.length) >= 4 && (n.includes(m) || m.includes(n)));
        if (!same) return false;
        return f.lat === null || g.lat === null || f.lng === null || g.lng === null || km({ lat: f.lat, lng: f.lng }, { lat: g.lat, lng: g.lng }) <= 1;
      });
      if (!dup) out.push(f);
    }
  return out.sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : a.title < b.title ? -1 : 1));
}
