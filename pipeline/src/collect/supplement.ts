// 보조 자료 수집 (FR-DATA-03 방문자수, FR-DATA-08 행사·날씨·공휴일, FR-DATA-09 운영 정보). 응답 형식은 2026-10-12 실호출 확인
// (tasks/hansan-phase1-foundation/artifacts/probe-rest-38189848752.jsonl).
import { join } from "node:path";
import type { DgGet } from "../lib/datagokr.js";
import { readFile } from "node:fs/promises";
import { appendJsonl, readJson, writeJson } from "../lib/store.js";
import { kstIso, kstParts } from "../lib/time.js";
import type { DailyUsage } from "../lib/usage.js";

const ymd = (d: Date) => kstParts(d).date.replaceAll("-", "");
const addDays = (d: Date, n: number) => new Date(d.getTime() + n * 86400_000);

async function call(get: DgGet, usage: DailyUsage, path: string, params: Record<string, string>) {
  if (!usage.tryConsume()) throw Object.assign(new Error("하루 상한"), { name: "DAILY_CAP" });
  await usage.save();
  return get(path, params);
}

// ── FR-DATA-03 지역별 방문자수 ── 약 33일 늦게 공개되므로 '마지막으로 저장한 날 다음 ~ 어제'를 받는다. 한 번에 최대 1만 건
export async function collectVisitors(input: { get: DgGet; usage: DailyUsage; provinces: string[]; dataDir: string; now: Date; firstLookbackDays: number }) {
  const { get, usage, provinces, dataDir, now } = input;
  const statePath = join(dataDir, "state", "visitors.json");
  const state = await readJson<{ lastDate?: string }>(statePath, {});
  const start = state.lastDate ?? ymd(addDays(now, -input.firstLookbackDays));
  const end = ymd(addDays(now, -1));
  if (start > end) return { rows: 0, lastDate: state.lastDate };

  const rows: { d: string; s: string; w: string; t: string; n: number }[] = [];
  let lastDate = state.lastDate ?? "";
  for (let page = 1; ; page++) {
    const r = await call(get, usage, "/DataLabService/locgoRegnVisitrDDList", { numOfRows: "10000", pageNo: String(page), startYmd: start, endYmd: end });
    for (const i of r.items) {
      if (!provinces.some((p) => String(i.signguCode).startsWith(p))) continue;
      rows.push({ d: i.baseYmd, s: String(i.signguCode), w: String(i.daywkDivCd), t: String(i.touDivCd), n: Number(i.touNum) });
      if (i.baseYmd > lastDate) lastDate = i.baseYmd;
    }
    if (page * 10000 >= r.totalCount || r.items.length === 0) break;
  }
  // 받은 날짜를 월별 파일에 나눠 쌓는다. 필드: d 날짜 · s 시군구 · w 요일코드 · t 1현지인 2외지인 3외국인 · n 방문자 수
  const byMonth = new Map<string, typeof rows>();
  for (const r of rows) (byMonth.get(r.d.slice(0, 6)) ?? byMonth.set(r.d.slice(0, 6), []).get(r.d.slice(0, 6))!).push(r);
  let added = 0;
  const key = (x: { d: string; s: string; w: string; t: string }) => `${x.d}|${x.s}|${x.w}|${x.t}`;
  for (const [m, rs] of byMonth) {
    const path = join(dataDir, "raw", "visitors", `${m.slice(0, 4)}-${m.slice(4)}.jsonl`);
    const have = new Set((await readFile(path, "utf8").catch(() => "")).split("\n").filter(Boolean).map((l) => key(JSON.parse(l))));
    const fresh = rs.filter((x) => !have.has(key(x)));
    await appendJsonl(path, fresh);
    added += fresh.length;
  }
  if (lastDate) await writeJson(statePath, { lastDate, source: "한국관광공사 관광빅데이터 지역별 방문자수", fetchedAt: kstIso(now) });
  return { rows: added, lastDate };
}

// ── FR-DATA-08 축제·행사 ── 오늘 진행 중이거나 horizonDays 안에 시작하는 행사, 최신 목록을 덮어쓴다
export async function collectEvents(input: { get: DgGet; usage: DailyUsage; regnParams: string[]; dataDir: string; now: Date; horizonDays: number; lookbackDays?: number }) {
  const { get, usage, dataDir, now } = input;
  const today = ymd(now);
  const until = ymd(addDays(now, input.horizonDays));
  const events = [];
  for (const regn of input.regnParams) {
    // eventStartDate 는 '이날 이후 시작' 조건이라, 이미 시작해 진행 중인 축제(예: 9월에 시작해 10월까지)를 받으려고 앞으로 당겨 묻는다
    const from = ymd(addDays(now, -(input.lookbackDays ?? 0)));
    const r = await call(get, usage, "/KorService2/searchFestival2", { numOfRows: "1000", arrange: "C", eventStartDate: from, lDongRegnCd: regn });
    for (const i of r.items) {
      // 오늘~horizon 과 겹치는 행사만(진행 중 포함)
      if (String(i.eventstartdate) > until || String(i.eventenddate) < today) continue;
      const rc = String(i.lDongRegnCd ?? "");
      events.push({
        contentId: String(i.contentid), title: i.title, address: i.addr1 ?? "", lat: i.mapy ? Number(i.mapy) : null, lng: i.mapx ? Number(i.mapx) : null,
        provinceCd: rc.slice(0, 2), signguCd: rc.length === 5 ? rc : `${rc}${i.lDongSignguCd ?? ""}`,
        start: String(i.eventstartdate), end: String(i.eventenddate),
      });
    }
  }
  await writeJson(join(dataDir, "latest", "events.json"), { updatedAt: kstIso(now), source: "TourAPI searchFestival2", from: today, until, events });
  return { events: events.length };
}

// ── FR-DATA-08 공휴일 ── 이번 달부터 months 개월, 기존 기록에 합친다
export async function collectHolidays(input: { get: DgGet; usage: DailyUsage; dataDir: string; now: Date; months: number }) {
  const path = join(input.dataDir, "sources", "holidays.json");
  const prev = await readJson<{ holidays: Record<string, string> }>(path, { holidays: {} });
  const t = kstParts(input.now);
  for (let k = 0; k < input.months; k++) {
    const d = new Date(Date.UTC(Number(t.yyyy), Number(t.mm) - 1 + k, 1));
    const r = await call(input.get, input.usage, "/getRestDeInfo", { numOfRows: "50", pageNo: "1", _type: "json", solYear: String(d.getUTCFullYear()), solMonth: String(d.getUTCMonth() + 1).padStart(2, "0") });
    const ym = `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
    for (const k2 of Object.keys(prev.holidays)) if (k2.startsWith(ym)) delete prev.holidays[k2];
    for (const i of r.items) if (i.isHoliday === "Y") prev.holidays[String(i.locdate)] = i.dateName;
  }
  await writeJson(path, { updatedAt: kstIso(input.now), source: "한국천문연구원 특일 정보", holidays: Object.fromEntries(Object.entries(prev.holidays).sort()) });
  return { holidays: Object.keys(prev.holidays).length };
}

// ── FR-DATA-08 날씨 ── 기상청 격자 좌표 변환(기상청 공개 LCC 변환식, 격자 5km)
export function toGrid(lat: number, lng: number): { nx: number; ny: number } {
  const RE = 6371.00877, GRID = 5.0, SLAT1 = 30, SLAT2 = 60, OLON = 126, OLAT = 38, XO = 43, YO = 136;
  const D = Math.PI / 180;
  const re = RE / GRID, s1 = SLAT1 * D, s2 = SLAT2 * D, olon = OLON * D, olat = OLAT * D;
  let sn = Math.tan(Math.PI * 0.25 + s2 * 0.5) / Math.tan(Math.PI * 0.25 + s1 * 0.5);
  sn = Math.log(Math.cos(s1) / Math.cos(s2)) / Math.log(sn);
  let sf = Math.tan(Math.PI * 0.25 + s1 * 0.5);
  sf = (Math.pow(sf, sn) * Math.cos(s1)) / sn;
  const ro = (re * sf) / Math.pow(Math.tan(Math.PI * 0.25 + olat * 0.5), sn);
  const ra = (re * sf) / Math.pow(Math.tan(Math.PI * 0.25 + lat * D * 0.5), sn);
  let theta = lng * D - olon;
  if (theta > Math.PI) theta -= 2 * Math.PI;
  if (theta < -Math.PI) theta += 2 * Math.PI;
  theta *= sn;
  return { nx: Math.floor(ra * Math.sin(theta) + XO + 0.5), ny: Math.floor(ro - ra * Math.cos(theta) + YO + 0.5) };
}

export interface DaySummary {
  tmx?: number;
  tmn?: number;
  popMax?: number;
  sky12?: string; // 정오 하늘상태 1맑음 3구름많음 4흐림
  rain: boolean; // 강수형태(PTY)가 하루 중 한 번이라도 0 이 아님
}

// 단기예보 항목들을 날짜별 요약으로 줄인다
export function summarize(items: { category: string; fcstDate: string; fcstTime: string; fcstValue: string }[]): Record<string, DaySummary> {
  const out: Record<string, DaySummary> = {};
  for (const i of items) {
    const d = (out[i.fcstDate] ??= { rain: false });
    const v = Number(i.fcstValue);
    if (i.category === "TMX") d.tmx = v;
    else if (i.category === "TMN") d.tmn = v;
    else if (i.category === "POP") d.popMax = Math.max(d.popMax ?? 0, v);
    else if (i.category === "PTY" && v !== 0) d.rain = true;
    else if (i.category === "SKY" && i.fcstTime === "1200") d.sky12 = i.fcstValue;
  }
  return out;
}

// 시·군·구 대표 격자(그 시·군·구 장소 좌표 평균)마다 단기예보 1회, 중기 육상예보는 예보 구역마다 1회
export async function collectWeather(input: {
  get: DgGet;
  usage: DailyUsage;
  points: { signguCd: string; lat: number; lng: number }[];
  midRegions: string[];
  dataDir: string;
  now: Date;
}) {
  const { get, usage, dataDir, now } = input;
  const base = ymd(now);
  const path = join(dataDir, "latest", "weather.json");
  // 직전 파일과 시·군·구·예보 구역 단위로 합친다 — 일부 실패·빈 응답이 직전 값을 지우지 않게 (FR-DATA-11, 2차 리뷰)
  const prev = await readJson<{ short: Record<string, unknown>; mid: Record<string, unknown> }>(path, { short: {}, mid: {} });
  const short: Record<string, unknown> = { ...prev.short };
  const mid: Record<string, unknown> = { ...prev.mid };
  let ok = 0;
  let failed = 0;
  const grids = new Map<string, Record<string, DaySummary>>();
  for (const p of input.points) {
    const g = toGrid(p.lat, p.lng);
    const k = `${g.nx},${g.ny}`;
    try {
      if (!grids.has(k)) {
        const r = await call(get, usage, "/VilageFcstInfoService_2.0/getVilageFcst", { numOfRows: "1000", pageNo: "1", dataType: "JSON", base_date: base, base_time: "0500", nx: String(g.nx), ny: String(g.ny) });
        // 발표 전(빈 응답)이거나 1,000건 넘게 잘렸으면 실패로 본다
        if (r.items.length === 0 || r.totalCount > r.items.length) throw Object.assign(new Error("단기예보 없음·잘림"), { name: "EMPTY" });
        grids.set(k, summarize(r.items));
      }
      short[p.signguCd] = { ...g, days: grids.get(k)!, baseDate: base };
      ok++;
    } catch {
      failed++;
    }
  }
  // 중기예보는 06·18시 발표 — 실행 시각 기준 가장 최근 발표분을 요청한다(05:40 실행이면 전날 18시. 2차 리뷰: 발표 전 시각 요청으로 빈 응답)
  const tmFc = midIssueTime(now);
  let midOk = 0;
  for (const regId of input.midRegions) {
    try {
      const r = await call(get, usage, "/MidFcstInfoService/getMidLandFcst", { numOfRows: "10", pageNo: "1", dataType: "JSON", regId, tmFc });
      if (!r.items[0]) throw Object.assign(new Error("중기예보 없음"), { name: "EMPTY" });
      mid[regId] = { ...r.items[0], tmFc };
      midOk++;
    } catch {
      failed++;
    }
  }
  if (ok + midOk > 0) await writeJson(path, { updatedAt: kstIso(now), source: "기상청 단기예보·중기육상예보", baseDate: base, short, mid });
  return { points: input.points.length, grids: grids.size, ok, mid: midOk, failed };
}

// 중기예보 발표 시각(KST 06·18시) 중 now 직전 것 — 발표 후 30분 여유
export function midIssueTime(now: Date): string {
  const k = new Date(now.getTime() + 9 * 3600_000 - 30 * 60_000);
  const h = k.getUTCHours();
  if (h >= 18) return `${ymd(now)}1800`;
  if (h >= 6) return `${ymd(now)}0600`;
  return `${kstParts(new Date(now.getTime() - 86400_000)).date.replaceAll("-", "")}1800`;
}

// ── FR-DATA-09 운영 정보 ── 유형별로 다른 필드를 휴무·이용시간 두 칸으로 모은다. 문장 그대로 저장하고 해석은 유형 판정 단계에서
const FIELDS: Record<string, { rest: string[]; hours: string[] }> = {
  "12": { rest: ["restdate"], hours: ["usetime"] },
  "14": { rest: ["restdateculture"], hours: ["usetimeculture"] },
  "28": { rest: ["restdateleports"], hours: ["usetimeleports"] },
  "15": { rest: [], hours: ["playtime", "eventstartdate", "eventenddate"] },
  "38": { rest: ["restdateshopping"], hours: ["opentime"] },
};

export async function collectOperation(input: { get: DgGet; usage: DailyUsage; places: { placeId: string; contentId: string; contentTypeId: string }[]; dataDir: string; now: Date }) {
  const { get, usage, dataDir, now } = input;
  const path = join(dataDir, "sources", "tour", "operation.json");
  const store = await readJson<{ operation: Record<string, { rest: string; hours: string; updatedAt: string }> }>(path, { operation: {} });
  const t = kstParts(now);
  const failPath = join(dataDir, "state", "failures", `${t.yyyy}-${t.mm}.jsonl`);
  // 오래 갱신 안 된 장소부터 — 상한에 걸려도 같은 장소만 계속 굶지 않게(2차 리뷰)
  const ordered = [...input.places].sort((a, b) => (store.operation[a.placeId]?.updatedAt ?? "").localeCompare(store.operation[b.placeId]?.updatedAt ?? ""));
  let ok = 0;
  let failed = 0;
  let streak = 0;
  let capped = false;
  for (const p of ordered) {
    if (streak >= 10) break;
    try {
      const r = await call(get, usage, "/KorService2/detailIntro2", { numOfRows: "1", contentId: p.contentId, contentTypeId: p.contentTypeId });
      // 빈 응답은 실패 — 직전 휴무·이용시간을 빈 값으로 덮지 않는다(2차 리뷰)
      const it = r.items[0];
      if (!it) throw Object.assign(new Error("빈 응답"), { name: "EMPTY" });
      const f = FIELDS[p.contentTypeId] ?? { rest: [], hours: [] };
      const join2 = (ks: string[]) => ks.map((k) => String(it[k] ?? "").replace(/<br\s*\/?>/gi, " ").trim()).filter(Boolean).join(" / ");
      store.operation[p.placeId] = { rest: join2(f.rest), hours: join2(f.hours), updatedAt: t.date };
      ok++;
      streak = 0;
    } catch (e) {
      if ((e as Error).name === "DAILY_CAP") {
        capped = true;
        break;
      }
      failed++;
      streak++;
      await appendJsonl(failPath, [{ at: kstIso(now), source: "tour_operation", placeId: p.placeId, code: (e as Error).name, message: "요청 실패" }]);
    }
  }
  if (ok > 0) await writeJson(path, { source: "TourAPI detailIntro2", operation: store.operation });
  return { attempted: ok + failed, ok, failed, skipped: input.places.length - ok - failed, capped };
}
