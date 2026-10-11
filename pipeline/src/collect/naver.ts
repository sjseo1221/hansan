// 네이버 인기도 신호 수집 (FR-DATA-06 검색어 트렌드, FR-DATA-07 블로그). NAVER API HUB, 2026-10-11 실호출 확인.
// 블로그 제목·요약은 저장하지 않는다(공개 저장소, 약관 재배포 범위 미확인). 게시글 수와 최근 게시일만 남긴다.
import { join } from "node:path";
import { appendJsonl, readJson, writeJson } from "../lib/store.js";
import { kstIso, kstParts } from "../lib/time.js";
import { DailyUsage } from "../lib/usage.js";

export const BLOG = "naver_blog";
export const TREND = "naver_trend";
const HOST = "https://naverapihub.apigw.ntruss.com";

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
}

type Failure = { at: string; source: string; placeId: string; code: string; message: string };

async function getJson(http: Http, url: string, init: RequestInit) {
  const res = await http(url, init);
  const text = await res.text();
  if (res.status !== 200) throw Object.assign(new Error(`HTTP ${res.status}`), { code: `HTTP_${res.status}` });
  return JSON.parse(text);
}

const failOf = (at: string, source: string, placeId: string, e: unknown): Failure => ({
  at,
  source,
  placeId,
  code: (e as { code?: string }).code ?? (e as Error).name ?? "ERROR",
  // 메시지에 인증 헤더가 들어갈 일은 없지만 URL·본문은 남기지 않는다 (NFR-SEC-01)
  message: "요청 실패",
});

// 블로그: 장소당 1회, 최신순 상위 N건의 게시일과 총 게시글 수
export async function collectBlog(ctx: Ctx) {
  const http = ctx.http ?? (fetch as unknown as Http);
  const t = kstParts(ctx.now);
  const at = kstIso(ctx.now);
  const usage = await DailyUsage.load(ctx.dataDir, BLOG, t.date, ctx.cfg.blogDailyCap);
  const rows: unknown[] = [];
  const failures: Failure[] = [];
  let skipped = 0;

  for (const p of ctx.places) {
    if (!usage.tryConsume()) {
      skipped++;
      continue;
    }
    const url = `${HOST}/search/v1/blog?query=${encodeURIComponent(p.keyword)}&display=${ctx.cfg.blogDisplay}&sort=date`;
    try {
      const j = await getJson(http, url, { headers: headers(ctx.auth), signal: AbortSignal.timeout(ctx.cfg.timeoutMs) });
      rows.push({
        placeId: p.placeId,
        keyword: p.keyword,
        total: Number(j.total),
        recentPostDates: (j.items ?? []).map((i: { postdate: string }) => i.postdate),
        fetchedAt: at,
        source: BLOG,
      });
    } catch (e) {
      failures.push(failOf(at, BLOG, p.placeId, e));
    }
  }

  await appendJsonl(join(ctx.dataDir, "raw", BLOG, `${t.yyyy}-${t.mm}`, `${t.dd}.jsonl`), rows);
  await appendJsonl(join(ctx.dataDir, "state", "failures", `${t.yyyy}-${t.mm}.jsonl`), failures);
  await usage.save();
  return { attempted: ctx.places.length - skipped, ok: rows.length, failed: failures.length, skipped };
}

// 검색어 트렌드: 기준 키워드 1개 + 장소 4개씩 묶어 요청하고, 장소 ratio ÷ 기준 ratio 로 정규화한다 (착수 계획서 B-1)
// 장기 백필(월 단위, backfillStart~)을 아직 안 받은 장소는 백필을, 받은 장소는 최근 recentWeeks 주(주 단위)를 갱신한다
export async function collectTrend(ctx: Ctx) {
  const http = ctx.http ?? (fetch as unknown as Http);
  const t = kstParts(ctx.now);
  const at = kstIso(ctx.now);
  const usage = await DailyUsage.load(ctx.dataDir, TREND, t.date, ctx.cfg.trendDailyCap);
  const statePath = join(ctx.dataDir, "state", "naver_trend_backfilled.json");
  const backfilled = new Set(await readJson<string[]>(statePath, []));
  const failures: Failure[] = [];
  let ok = 0;
  let skipped = 0;

  const recentStart = new Date(ctx.now.getTime() - ctx.cfg.recentWeeks * 7 * 86400_000);
  const plans = [
    { mode: "backfill" as const, timeUnit: "month", startDate: ctx.cfg.backfillStart, places: ctx.places.filter((p) => !backfilled.has(p.placeId)) },
    { mode: "recent" as const, timeUnit: "week", startDate: kstParts(recentStart).date, places: ctx.places.filter((p) => backfilled.has(p.placeId)) },
  ];

  for (const plan of plans) {
    for (let i = 0; i < plan.places.length; i += 4) {
      const group = plan.places.slice(i, i + 4);
      if (!usage.tryConsume()) {
        skipped += group.length;
        continue;
      }
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
        const results: { title: string; data: { period: string; ratio: number }[] }[] = j.results ?? [];
        const anchor = new Map(results.find((r) => r.title === "__anchor__")?.data.map((d) => [d.period, d.ratio]) ?? []);
        const rows = group.map((p) => {
          const data = results.find((r) => r.title === p.placeId)?.data ?? [];
          return {
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
          };
        });
        const file = plan.mode === "backfill" ? "backfill.jsonl" : `${t.yyyy}-${t.mm}-${t.dd}.jsonl`;
        await appendJsonl(join(ctx.dataDir, "raw", TREND, file), rows);
        if (plan.mode === "backfill") group.forEach((p) => backfilled.add(p.placeId));
        ok += group.length;
      } catch (e) {
        group.forEach((p) => failures.push(failOf(at, TREND, p.placeId, e)));
      }
    }
  }

  await writeJson(statePath, [...backfilled].sort());
  await appendJsonl(join(ctx.dataDir, "state", "failures", `${t.yyyy}-${t.mm}.jsonl`), failures);
  await usage.save();
  return { places: ctx.places.length, ok, failed: failures.length, skipped };
}
