// 설정 파일 정합성 시험 — 운영자가 파일을 고쳐도 서로 어긋나지 않게 한다 (FR-OPS-05, FR-TYPE-10)
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const load = async (name: string) => parse(await readFile(`config/${name}.yaml`, "utf8"));

describe("config", () => {
  it("모든 설정 파일이 읽힌다", async () => {
    for (const name of ["sources", "thresholds", "categories", "companions", "regions", "llm"]) {
      expect(await load(name), name).toBeTruthy();
    }
  });

  it("동행 적합 표는 정의된 분류만 쓴다", async () => {
    const ids = new Set((await load("categories")).categories.map((c: any) => c.id));
    for (const c of (await load("companions")).companions) {
      for (const s of c.suitable) expect(ids.has(s), `${c.id} → ${s}`).toBe(true);
    }
  });

  it("동행 유형은 명세서의 5종이다 (FR-FLT-03)", async () => {
    const labels = (await load("companions")).companions.map((c: any) => c.label);
    expect(labels).toEqual(["아이 동반", "커플", "부모님 동반", "친구", "혼자"]);
  });

  it("대표 유형 순서는 다섯 유형을 한 번씩 모두 담는다 (FR-TYPE-07)", async () => {
    const t = await load("thresholds");
    expect([...t.representativePriority].sort()).toEqual(Object.keys(t.types).sort());
  });

  it("한산 가능성 구간과 인기도 가중치가 올바르다", async () => {
    const t = await load("thresholds");
    expect(t.quietLikelihood.highMax).toBeLessThan(t.quietLikelihood.mediumMax);
    expect(t.popularity.searchWeight + t.popularity.blogWeight + (t.popularity.navWeight ?? 0)).toBeCloseTo(1);
  });

  it("서울 장소 카테고리가 모두 분류에 연결된다 (FR-SCORE-07)", async () => {
    const cat = await load("categories");
    const ids = new Set(cat.categories.map((c: any) => c.id));
    const places = JSON.parse(await readFile("data/sources/seoul/places.json", "utf8")).places;
    for (const p of places) {
      const mapped = cat.seoulCategoryMap[p.category];
      expect(ids.has(mapped), `${p.areaCd} ${p.category}`).toBe(true);
    }
  });

  it("대화 비용 차단선은 월 예산보다 낮다 (NFR-COST-03)", async () => {
    const llm = await load("llm");
    expect(llm.budget.appCutoffUsd).toBeLessThan(llm.budget.monthlyUsd);
  });
});

describe("예약 표 동기화 (2차 리뷰)", () => {
  it("Worker SCHEDULE 키 = wrangler.toml crons, 값은 모두 실제 워크플로 파일", async () => {
    const workerPath = "../../worker/cron/index.js";
    const { SCHEDULE } = (await import(workerPath)) as { SCHEDULE: Record<string, string> };
    const toml = await readFile("worker/cron/wrangler.toml", "utf8");
    const crons: string[] = JSON.parse(toml.match(/crons = (\[.*\])/)![1]);
    expect(Object.keys(SCHEDULE).sort()).toEqual([...crons].sort());
    for (const wf of Object.values(SCHEDULE) as string[]) {
      await expect(readFile(`.github/workflows/${wf}`, "utf8"), wf).resolves.toContain("workflow_dispatch");
    }
  });
});

describe("무료 한도 안의 상한 (NFR-COST-02)", () => {
  it("출처별 하루 상한 합이 제공처 무료 한도를 넘지 않는다 (월 한도는 31일 기준)", async () => {
    const s = await load("sources");
    const llm = await load("llm");
    const cap: Record<string, number> = {
      tour_build: s.tour.caps.build,
      tour_events: s.tour.caps.events,
      tour_operation: s.tour.caps.operation,
      tour_overview: s.tour.caps.overview,
      cnctr: s.cnctr.dailyCap,
      datalab: s.aux.datalabDailyCap,
      kma: s.aux.kmaDailyCap,
      kasi: s.aux.kasiDailyCap,
      tour_hub: s.aux.hubDailyCap,
      seoul_citydata: s.seoul_citydata.dailyCap,
      seoul_events: s.aux.seoulEventsDailyCap,
      naver_blog: s.naver.blogDailyCap,
      naver_blog_llm: llm.generation.reviewBlogCalls,
      naver_trend: s.naver.trendDailyCap,
    };
    for (const [name, l] of Object.entries(s.freeLimits as Record<string, { limit: number; per: string; counters: string[] }>)) {
      const daily = l.counters.reduce((n, c) => n + (cap[c] ?? NaN), 0);
      expect(Number.isFinite(daily), `${name} 카운터 상한 없음`).toBe(true);
      expect(l.per === "month" ? daily * 31 : daily, name).toBeLessThanOrEqual(l.limit);
    }
  });
});
