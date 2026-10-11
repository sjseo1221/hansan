// 서울 실시간 인구 수집 (FR-DATA-04). 매시간 121곳을 1곳씩 호출해 실측 혼잡을 쌓는다.
// API 형식은 2026-10-11 실호출로 확인: 정상은 JSON + RESULT.CODE=INFO-000, 오류는 json 요청에도 XML.
import { join } from "node:path";
import type { SeoulCitydataConfig } from "../lib/config.js";
import { appendJsonl, readJson, writeJson } from "../lib/store.js";
import { kstIso, kstParts } from "../lib/time.js";
import { DailyUsage } from "../lib/usage.js";

export const SOURCE = "seoul_citydata";

export interface Place {
  areaCd: string;
  areaNm: string;
  category: string;
}

export interface SeoulRecord {
  areaCd: string;
  areaNm: string;
  congestLvl: string;
  ppltnMin: number;
  ppltnMax: number;
  ppltnTime: string;
  fetchedAt: string;
  source: string;
}

export type Parsed =
  | { ok: true; record: Omit<SeoulRecord, "fetchedAt" | "source"> }
  | { ok: false; code: string; message: string };

export type FetchText = (url: string, timeoutMs: number) => Promise<string>;

export const fetchText: FetchText = async (url, timeoutMs) => {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  return res.text();
};

export function parseResponse(body: string): Parsed {
  let json: any;
  try {
    json = JSON.parse(body);
  } catch {
    const code = body.match(/<CODE>([^<]*)<\/CODE>/)?.[1] ?? "UNPARSEABLE";
    const message = body.match(/<MESSAGE>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/MESSAGE>/)?.[1]?.trim() ?? "";
    return { ok: false, code, message };
  }
  const code = json?.RESULT?.["RESULT.CODE"] ?? "NO_RESULT";
  const row = json?.["SeoulRtd.citydata_ppltn"]?.[0];
  if (code !== "INFO-000" || !row) {
    return { ok: false, code, message: json?.RESULT?.["RESULT.MESSAGE"] ?? "빈 응답" };
  }
  return {
    ok: true,
    record: {
      areaCd: row.AREA_CD,
      areaNm: row.AREA_NM,
      congestLvl: row.AREA_CONGEST_LVL,
      ppltnMin: Number(row.AREA_PPLTN_MIN),
      ppltnMax: Number(row.AREA_PPLTN_MAX),
      ppltnTime: row.PPLTN_TIME,
    },
  };
}

export interface CollectInput {
  places: Place[];
  cfg: SeoulCitydataConfig;
  key: string;
  dataDir: string;
  now: Date;
  fetchText?: FetchText;
}

export interface CollectResult {
  attempted: number;
  ok: number;
  failed: number;
  skipped: number;
}

export async function collectSeoul(input: CollectInput): Promise<CollectResult> {
  const { places, cfg, key, dataDir, now } = input;
  const get = input.fetchText ?? fetchText;
  const t = kstParts(now);
  const fetchedAt = kstIso(now);

  const usage = await DailyUsage.load(dataDir, SOURCE, t.date, cfg.dailyCap);
  const cursorPath = join(dataDir, "state", "cursor", `${SOURCE}.json`);
  const start = (await readJson<{ next: number }>(cursorPath, { next: 0 })).next % places.length;
  const ordered = [...places.slice(start), ...places.slice(0, start)];

  // 상한에 닿으면 남은 장소는 다음 실행으로 넘긴다 (FR-DATA-10)
  const batch: Place[] = [];
  for (const p of ordered) {
    if (!usage.tryConsume()) break;
    batch.push(p);
  }

  const records: SeoulRecord[] = [];
  const failures: { at: string; source: string; areaCd: string; code: string; message: string }[] = [];
  const fail = (areaCd: string, code: string, message: string) =>
    failures.push({ at: fetchedAt, source: SOURCE, areaCd, code, message });

  let i = 0;
  const worker = async () => {
    while (i < batch.length) {
      const place = batch[i++];
      const url = `${cfg.baseUrl}/${encodeURIComponent(key)}/json/${cfg.service}/1/5/${place.areaCd}`;
      try {
        const parsed = parseResponse(await get(url, cfg.timeoutMs));
        if (!parsed.ok) fail(place.areaCd, parsed.code, parsed.message);
        else if (parsed.record.areaCd !== place.areaCd) fail(place.areaCd, "AREA_MISMATCH", `응답 장소 ${parsed.record.areaCd}`);
        else records.push({ ...parsed.record, fetchedAt, source: SOURCE });
      } catch (e) {
        // 오류 메시지에 인증키가 든 URL 을 남기지 않는다 (NFR-SEC-01)
        fail(place.areaCd, (e as Error).name || "FETCH_ERROR", "요청 실패 또는 시간 초과");
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, cfg.concurrency) }, worker));

  records.sort((a, b) => a.areaCd.localeCompare(b.areaCd));
  await appendJsonl(join(dataDir, "raw", SOURCE, `${t.yyyy}-${t.mm}`, `${t.dd}.jsonl`), records);

  // 장소별 최신값: 실패한 장소는 직전 값을 그대로 둔다 (FR-DATA-11, NFR-REL-01)
  if (records.length > 0) {
    const latestPath = join(dataDir, "latest", `${SOURCE}.json`);
    const latest = await readJson<{ updatedAt?: string; places: Record<string, SeoulRecord> }>(latestPath, { places: {} });
    for (const r of records) latest.places[r.areaCd] = r;
    latest.updatedAt = fetchedAt;
    await writeJson(latestPath, latest);
  }
  await appendJsonl(join(dataDir, "state", "failures", `${t.yyyy}-${t.mm}.jsonl`), failures);

  await writeJson(cursorPath, { next: (start + batch.length) % places.length });
  await usage.save();

  return { attempted: batch.length, ok: records.length, failed: failures.length, skipped: places.length - batch.length };
}
