// 네이버 인기도 신호 수집 (FR-DATA-06 검색어 트렌드, FR-DATA-07 블로그). NAVER API HUB, 2026-10-11 실호출 확인.
// 블로그 제목·요약은 저장하지 않는다(공개 저장소, 약관 재배포 범위 미확인). 게시글 수와 최근 게시일만 남긴다.
import { join } from "node:path";
import { appendJsonl, readJson, writeJson } from "../lib/store.js";
import { kstIso, kstParts } from "../lib/time.js";
import { DailyUsage } from "../lib/usage.js";

export const BLOG = "naver_blog";
export const TREND = "naver_trend";
const HOST = "https://naverapihub.apigw.ntruss.com";

// 연속 실패가 이만큼 나면 남은 호출을 멈춘다(키 오류·장애 시 상한 소진과 긴 실행 방지)
export const MAX_CONSECUTIVE_FAILURES = 10;

// 장소를 요일별 7묶음으로 나눈다 — 매일 한 묶음씩 돌아 장소마다 주 1회 갱신하면서 하루 호출을 한도 안에 둔다
export function weekdayBucket(placeId: string): number {
  let h = 0;
  for (const ch of placeId) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return h % 7;
}

export interface PlaceRef {
  placeId: string;
  name: string;
  keyword: string;
}

export interface NaverConfig {
  blogDailyCap: number;
  trendDailyCap: number;
  blogDisplay: number;
  anchorKeyword: string;
  backfillStart: string;
  recentWeeks: number;
  timeoutMs: number;
  timeBudgetMs: number;
}

export interface NaverAuth {
  id: string;
  secret: string;
}

export type Http = (url: string, init: RequestInit) => Promise<{ status: number; text: () => Promise<string> }>;

const headers = (a: NaverAuth) => ({ "X-NCP-APIGW-API-KEY-ID": a.id, "X-NCP-APIGW-API-KEY": a.secret });

interface Ctx {
  places: PlaceRef[];
  cfg: NaverConfig;
  auth: NaverAuth;
  dataDir: string;
  now: Date;
  http?: Http;
  clock?: () => number;
}

type Failure = { at: string; source: string; placeId: string; code: string; message: string };

async function getJson(http: Http, url: string, init: RequestInit) {
  const res = await http(url, init);
  const text = await res.text();
  if (res.status !== 200) throw Object.assign(new Error(`HTTP ${res.status}`), { code: `HTTP_${res.status}` });
  try {
    return JSON.parse(text);
  } catch {
    throw Object.assign(new Error("JSON 아님"), { code: "UNPARSEABLE" });
  }
}

// 메시지에 인증 헤더·URL·본문을 남기지 않는다 (NFR-SEC-01)
const failOf = (at: string, source: string, placeId: string, e: unknown): Failure => ({
  at,
  source,
  placeId,
  code: (e as { code?: string }).code ?? (e as Error).name ?? "ERROR",
  message: "요청 실패",
});

// 연속 실패·실행 시간 예산을 함께 보는 중단 판정
function breaker(ctx: Ctx) {
  const clock = ctx.clock ?? Date.now;
  const started = clock();
  let streak = 0;
  return {
    record(ok: boolean) {
      streak = ok ? 0 : streak + 1;
    },
    tripped() {
      return streak >= MAX_CONSECUTIVE_FAILURES || clock() - started > ctx.cfg.timeBudgetMs;
    },
  };
}

// 블로그: 장소당 1회, 최신순 상위 N건의 게시일과 총 게시글 수
export async function collectBlog(ctx: Ctx) {
  const http = ctx.http ?? (fetch as unknown as Http);
  const t = kstParts(ctx.now);
  const at = kstIso(ctx.now);
  const usage = await DailyUsage.load(ctx.dataDir, BLOG, t.date, ctx.cfg.blogDailyCap);
  const rawPath = join(ctx.dataDir, "raw", BLOG, `${t.yyyy}-${t.mm}`, `${t.dd}.jsonl`);
  const failPath = join(ctx.dataDir, "state", "failures", `${t.yyyy}-${t.mm}.jsonl`);
  const brk = breaker(ctx);
  let ok = 0;
  let failed = 0;
  let skipped = 0;
  let aborted = 0;

  for (const [idx, p] of ctx.places.entries()) {
    if (brk.tripped()) {
      aborted = ctx.places.length - idx;
      break;
    }
    if (!usage.tryConsume()) {
      skipped++;
      continue;
    }
    // 호출 전에 사용량을 저장한다 — 중간에 중단돼도 과소 집계되지 않게
    await usage.save();
    const url = `${HOST}/search/v1/blog?query=${encodeURIComponent(p.keyword)}&display=${ctx.cfg.blogDisplay}&sort=date`;
    try {
      const j = await getJson(http, url, { headers: headers(ctx.auth), signal: AbortSignal.timeout(ctx.cfg.timeoutMs) });
      if (!Array.isArray(j.items) || !Number.isFinite(Number(j.total))) throw Object.assign(new Error("빈 응답"), { code: "EMPTY" });
      await appendJsonl(rawPath, [
        {
          placeId: p.placeId,
          keyword: p.keyword,
          total: Number(j.total),
          recentPostDates: j.items.map((i: { postdate: string }) => i.postdate),
          fetchedAt: at,
          source: BLOG,
        },
      ]);
      ok++;
      brk.record(true);
    } catch (e) {
      await appendJsonl(failPath, [failOf(at, BLOG, p.placeId, e)]);
      failed++;
      brk.record(false);
    }
  }

  return { attempted: ok + failed, ok, failed, skipped, aborted };
}

// 검색어 트렌드: 기준 키워드 1개 + 장소 4개씩 묶어 요청하고, 장소 ratio ÷ 기준 ratio 로 정규화한다 (착수 계획서 B-1)
// 장기 백필(월 단위, backfillStart~)을 아직 안 받은 장소는 백필을, 받은 장소는 최근 recentWeeks 주(주 단위)를 갱신한다.
// 기준 키워드나 장소 결과가 비어 있으면 그 장소는 실패로 기록하고 백필 완료로 표시하지 않는다 (FR-DATA-11)
export async function collectTrend(ctx: Ctx) {
  const http = ctx.http ?? (fetch as unknown as Http);
  const t = kstParts(ctx.now);
  const at = kstIso(ctx.now);
  const usage = await DailyUsage.load(ctx.dataDir, TREND, t.date, ctx.cfg.trendDailyCap);
  const statePath = join(ctx.dataDir, "state", "naver_trend_backfilled.json");
  const failPath = join(ctx.dataDir, "state", "failures", `${t.yyyy}-${t.mm}.jsonl`);
  const backfilled = new Set(await readJson<string[]>(statePath, []));
  const brk = breaker(ctx);
  let ok = 0;
  let failed = 0;
  let skipped = 0;
  let aborted = 0;

  const recentStart = new Date(ctx.now.getTime() - ctx.cfg.recentWeeks * 7 * 86400_000);
  const plans = [
    { mode: "backfill" as const, timeUnit: "month", startDate: ctx.cfg.backfillStart, places: ctx.places.filter((p) => !backfilled.has(p.placeId)) },
    { mode: "recent" as const, timeUnit: "week", startDate: kstParts(recentStart).date, places: ctx.places.filter((p) => backfilled.has(p.placeId)) },
  ];

  for (const plan of plans) {
    for (let i = 0; i < plan.places.length; i += 4) {
      const group = plan.places.slice(i, i + 4);
      if (brk.tripped()) {
        aborted += group.length;
        continue;
      }
      if (!usage.tryConsume()) {
        skipped += group.length;
        continue;
      }
      await usage.save();
      const body = {
        startDate: plan.startDate,
        endDate: t.date,
        timeUnit: plan.timeUnit,
        keywordGroups: [
          { groupName: "__anchor__", keywords: [ctx.cfg.anchorKeyword] },
          ...group.map((p) => ({ groupName: p.placeId, keywords: [p.keyword] })),
        ],
      };
      try {
        const j = await getJson(http, `${HOST}/search-trend/v1/search`, {
          method: "POST",
          headers: { ...headers(ctx.auth), "Content-Type": "application/json" },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(ctx.cfg.timeoutMs),
        });
        const results: { title: string; data: { period: string; ratio: number }[] }[] = Array.isArray(j.results) ? j.results : [];
        const anchorData = results.find((r) => r.title === "__anchor__")?.data ?? [];
        if (anchorData.length === 0) throw Object.assign(new Error("기준 키워드 결과 없음"), { code: "EMPTY_ANCHOR" });
        const anchor = new Map(anchorData.map((d) => [d.period, d.ratio]));

        const rows = [];
        for (const p of group) {
          const data = results.find((r) => r.title === p.placeId)?.data ?? [];
          if (data.length === 0) {
            await appendJsonl(failPath, [failOf(at, TREND, p.placeId, { code: "EMPTY" })]);
            failed++;
            continue;
          }
          rows.push({
            placeId: p.placeId,
            keyword: p.keyword,
            anchorKeyword: ctx.cfg.anchorKeyword,
            timeUnit: plan.timeUnit,
            // 기준 키워드가 0인 기간은 비율을 만들 수 없어 null
            series: data.map((d) => {
              const a = anchor.get(d.period);
              return { period: d.period, ratio: d.ratio, anchorRatio: a ?? null, relative: a ? d.ratio / a : null };
            }),
            fetchedAt: at,
            source: TREND,
          });
        }
        const file = plan.mode === "backfill" ? "backfill.jsonl" : `${t.yyyy}-${t.mm}-${t.dd}.jsonl`;
        await appendJsonl(join(ctx.dataDir, "raw", TREND, file), rows);
        if (plan.mode === "backfill") {
          rows.forEach((r) => backfilled.add(r.placeId));
          // 그룹마다 바로 저장한다 — 중간에 중단돼도 다음 실행이 같은 백필을 다시 쌓지 않게
          await writeJson(statePath, [...backfilled].sort());
        }
        ok += rows.length;
        brk.record(rows.length > 0);
      } catch (e) {
        await appendJsonl(failPath, group.map((p) => failOf(at, TREND, p.placeId, e)));
        failed += group.length;
        brk.record(false);
      }
    }
  }

  return { attempted: ok + failed, ok, failed, skipped, aborted };
}
