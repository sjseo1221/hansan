import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { collectBlog, collectTrend, type Http, type NaverConfig, type PlaceRef } from "../src/collect/naver.js";

const cfg: NaverConfig = {
  blogDailyCap: 100,
  trendDailyCap: 100,
  blogDisplay: 3,
  anchorKeyword: "기준",
  backfillStart: "2016-01-01",
  recentWeeks: 13,
  timeoutMs: 1000,
  timeBudgetMs: 60_000,
};
const auth = { id: "ID-SECRET-1", secret: "SECRET-XYZ" };
const now = new Date("2026-10-12T03:00:00Z");
const places: PlaceRef[] = ["A", "B", "C", "D", "E"].map((x) => ({ placeId: `P${x}`, name: x, keyword: `kw${x}` }));
const tmp = () => mkdtemp(join(tmpdir(), "hansan-naver-"));
const lines = async (p: string) => (await readFile(p, "utf8")).trim().split("\n").map((l) => JSON.parse(l));

// 실호출 응답 형식(2026-10-11 probe)을 흉내 낸 가짜 서버
function fake(opts: { failKeyword?: string } = {}): Http & { calls: { url: string; body?: any }[] } {
  const calls: { url: string; body?: any }[] = [];
  const http = (async (url: string, init: RequestInit) => {
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url, body });
    if (url.includes("/search/v1/blog")) {
      if (opts.failKeyword && url.includes(opts.failKeyword)) return { status: 500, text: async () => "err" };
      return {
        status: 200,
        text: async () => JSON.stringify({ total: 1234, items: [{ title: "t", description: "d", postdate: "20261010" }, { title: "t2", description: "d2", postdate: "20261001" }] }),
      };
    }
    const results = body.keywordGroups.map((g: any, i: number) => ({
      title: g.groupName,
      data: [
        { period: "2026-09-01", ratio: g.groupName === "__anchor__" ? 50 : 10 * i },
        { period: "2026-10-01", ratio: g.groupName === "__anchor__" ? 0 : 5 },
      ],
    }));
    return { status: 200, text: async () => JSON.stringify({ results }) };
  }) as Http & { calls: { url: string; body?: any }[] };
  http.calls = calls;
  return http;
}

describe("collectBlog", () => {
  it("게시글 수와 최근 게시일만 저장하고 제목·요약은 남기지 않는다", async () => {
    const dataDir = await tmp();
    const res = await collectBlog({ places, cfg, auth, dataDir, now, http: fake() });
    expect(res).toEqual({ attempted: 5, ok: 5, failed: 0, skipped: 0, aborted: 0 });
    const rows = await lines(join(dataDir, "raw", "naver_blog", "2026-10", "12.jsonl"));
    expect(rows[0]).toMatchObject({ placeId: "PA", total: 1234, recentPostDates: ["20261010", "20261001"], source: "naver_blog" });
    const text = await readFile(join(dataDir, "raw", "naver_blog", "2026-10", "12.jsonl"), "utf8");
    expect(text).not.toContain('"title"');
    expect(text).not.toContain('"description"');
  });

  it("하루 상한을 넘기지 않고, 실패는 인증 값 없이 기록한다", async () => {
    const dataDir = await tmp();
    const res = await collectBlog({ places, cfg: { ...cfg, blogDailyCap: 3 }, auth, dataDir, now, http: fake({ failKeyword: "kwB" }) });
    expect(res).toEqual({ attempted: 3, ok: 2, failed: 1, skipped: 2, aborted: 0 });
    const text = await readFile(join(dataDir, "state", "failures", "2026-10.jsonl"), "utf8");
    expect(text).toContain("HTTP_500");
    expect(text).not.toContain("SECRET");
  });
});

describe("collectTrend", () => {
  it("기준 키워드 + 장소 4개씩 묶고, 처음엔 월 단위 백필을 받는다", async () => {
    const dataDir = await tmp();
    const http = fake();
    const res = await collectTrend({ places, cfg, auth, dataDir, now, http });
    expect(res).toMatchObject({ attempted: 5, ok: 5, failed: 0 });
    expect(http.calls).toHaveLength(2); // 4 + 1
    expect(http.calls[0].body.keywordGroups[0]).toEqual({ groupName: "__anchor__", keywords: ["기준"] });
    expect(http.calls[0].body.keywordGroups).toHaveLength(5);
    expect(http.calls[0].body).toMatchObject({ timeUnit: "month", startDate: "2016-01-01" });
  });

  it("기준 대비 비율을 저장하고, 기준이 0인 기간은 null 로 둔다", async () => {
    const dataDir = await tmp();
    await collectTrend({ places, cfg, auth, dataDir, now, http: fake() });
    const rows = await lines(join(dataDir, "raw", "naver_trend", "backfill.jsonl"));
    const pb = rows.find((r) => r.placeId === "PB");
    expect(pb.series[0]).toEqual({ period: "2026-09-01", ratio: 20, anchorRatio: 50, relative: 0.4 });
    expect(pb.series[1].relative).toBeNull();
  });

  it("백필을 받은 장소는 다음부터 최근 13주를 주 단위로 갱신한다", async () => {
    const dataDir = await tmp();
    await collectTrend({ places, cfg, auth, dataDir, now, http: fake() });
    const http = fake();
    await collectTrend({ places, cfg, auth, dataDir, now, http });
    expect(http.calls.every((c) => c.body.timeUnit === "week")).toBe(true);
    expect(http.calls[0].body.startDate).toBe("2026-07-13");
  });
});
