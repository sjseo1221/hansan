// 2026-10-12 리뷰(claude-reviewer · review-expert) 지적 재발 방지 시험
import { mkdtemp, readFile, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { collectBlog, collectTrend, MAX_CONSECUTIVE_FAILURES, type Http, type NaverConfig, type PlaceRef } from "../src/collect/naver.js";
import { attemptedThisHour, collectSeoul, fetchText, type Place } from "../src/collect/seoul.js";
import type { SeoulCitydataConfig } from "../src/lib/config.js";
import { exitCode } from "../src/lib/exit.js";
import { kstIso, kstParts } from "../src/lib/time.js";
import { DailyUsage } from "../src/lib/usage.js";

const tmp = () => mkdtemp(join(tmpdir(), "hansan-fix-"));
const now = new Date("2026-10-12T03:00:00Z");
const auth = { id: "i", secret: "s" };
const naverCfg: NaverConfig = {
  blogDailyCap: 100, trendDailyCap: 100, blogDisplay: 3, anchorKeyword: "기준",
  backfillStart: "2016-01-01", recentWeeks: 13, timeoutMs: 1000, timeBudgetMs: 60_000,
};
const places: PlaceRef[] = ["A", "B", "C"].map((x) => ({ placeId: `P${x}`, name: x, keyword: `kw${x}` }));
const json = (status: number, body: unknown) => ({ status, text: async () => JSON.stringify(body) });

describe("KST 날짜 경계", () => {
  it("UTC 14:59 는 같은 날, 15:00 은 KST 다음 날 0시다", () => {
    expect(kstParts(new Date("2026-10-11T14:59:59Z"))).toMatchObject({ date: "2026-10-11", hh: "23" });
    expect(kstParts(new Date("2026-10-11T15:00:00Z"))).toMatchObject({ date: "2026-10-12", hh: "00" });
  });
  it("연말 경계", () => {
    expect(kstParts(new Date("2026-12-31T15:00:00Z")).date).toBe("2027-01-01");
    expect(kstIso(new Date("2026-12-31T15:00:00Z"))).toBe("2027-01-01T00:00:00.000+09:00");
  });
});

describe("사용량 파일 손상", () => {
  it("count 가 숫자가 아니면 한도를 다 쓴 것으로 본다(한도 무력화 방지)", async () => {
    const dataDir = await tmp();
    await mkdir(join(dataDir, "state", "usage", "x"), { recursive: true });
    await writeFile(join(dataDir, "state", "usage", "x", "2026-10-12.json"), JSON.stringify({ count: "oops" }));
    const u = await DailyUsage.load(dataDir, "x", "2026-10-12", 10);
    expect(u.tryConsume()).toBe(false);
  });
});

describe("종료 코드", () => {
  it("상한 소진·연속 실패 중단·실패율 50% 초과는 실패로 끝낸다", () => {
    expect(exitCode({ attempted: 0, ok: 0, failed: 0, skipped: 121 })).toBe(1);
    expect(exitCode({ attempted: 10, ok: 0, failed: 10, skipped: 0, aborted: 111 })).toBe(1);
    expect(exitCode({ attempted: 121, ok: 60, failed: 61, skipped: 0 })).toBe(1);
    expect(exitCode({ attempted: 121, ok: 120, failed: 1, skipped: 0 })).toBe(0);
    expect(exitCode({ attempted: 0, ok: 0, failed: 0, skipped: 0 })).toBe(0);
  });
});

describe("네이버 트렌드 빈 응답 (리뷰 CR#1 · M2)", () => {
  it("장소 결과가 비면 실패로 기록하고 백필 완료로 표시하지 않는다 — 다음 실행에서 다시 백필", async () => {
    const dataDir = await tmp();
    const empty: Http = async (_u, init) => {
      const body = JSON.parse(String(init.body));
      // 기준 키워드는 오지만 장소 PB 결과가 빠진 응답
      return json(200, { results: body.keywordGroups.filter((g: any) => g.groupName !== "PB").map((g: any) => ({ title: g.groupName, data: [{ period: "2026-09-01", ratio: 10 }] })) });
    };
    const res = await collectTrend({ places, cfg: naverCfg, auth, dataDir, now, http: empty });
    expect(res).toMatchObject({ ok: 2, failed: 1 });
    const state = JSON.parse(await readFile(join(dataDir, "state", "naver_trend_backfilled.json"), "utf8"));
    expect(state).toEqual(["PA", "PC"]);

    const calls: any[] = [];
    const full: Http = async (_u, init) => {
      const body = JSON.parse(String(init.body));
      calls.push(body);
      return json(200, { results: body.keywordGroups.map((g: any) => ({ title: g.groupName, data: [{ period: "2026-09-01", ratio: 10 }] })) });
    };
    await collectTrend({ places, cfg: naverCfg, auth, dataDir, now, http: full });
    const backfillCall = calls.find((c) => c.timeUnit === "month");
    expect(backfillCall.keywordGroups.map((g: any) => g.groupName)).toEqual(["__anchor__", "PB"]);
  });

  it("기준 키워드 결과가 없으면 그룹 전체를 실패로 둔다", async () => {
    const dataDir = await tmp();
    const noAnchor: Http = async () => json(200, { results: [{ title: "PA", data: [{ period: "2026-09-01", ratio: 1 }] }] });
    const res = await collectTrend({ places, cfg: naverCfg, auth, dataDir, now, http: noAnchor });
    expect(res).toMatchObject({ ok: 0, failed: 3 });
    const fails = await readFile(join(dataDir, "state", "failures", "2026-10.jsonl"), "utf8");
    expect(fails).toContain("EMPTY_ANCHOR");
  });
});

describe("네이버 블로그 연속 실패 중단 (리뷰 CR#4)", () => {
  it(`연속 ${MAX_CONSECUTIVE_FAILURES}회 실패하면 남은 장소를 호출하지 않는다`, async () => {
    const dataDir = await tmp();
    const many: PlaceRef[] = Array.from({ length: 25 }, (_, i) => ({ placeId: `P${i}`, name: `${i}`, keyword: `k${i}` }));
    let calls = 0;
    const down: Http = async () => {
      calls++;
      return json(500, {});
    };
    const res = await collectBlog({ places: many, cfg: naverCfg, auth, dataDir, now, http: down });
    expect(calls).toBe(MAX_CONSECUTIVE_FAILURES);
    expect(res).toMatchObject({ attempted: 10, failed: 10, aborted: 15 });
    expect(exitCode(res)).toBe(1);
  });

  it("실행 시간 예산을 넘으면 멈춘다", async () => {
    const dataDir = await tmp();
    let t = 0;
    const ok: Http = async () => json(200, { total: 1, items: [] });
    const res = await collectBlog({ places, cfg: { ...naverCfg, timeBudgetMs: 1500 }, auth, dataDir, now, http: ok, clock: () => (t += 1000) });
    expect(res.aborted).toBeGreaterThan(0);
  });
});

describe("서울 수집 안전장치 (리뷰 CR#2 · M1 · CR#12)", () => {
  const cfg: SeoulCitydataConfig = { baseUrl: "http://x", service: "s", dailyCap: 100, timeoutMs: 1000, concurrency: 1 };

  it("장소 목록이 비면 조용히 성공하지 않고 오류로 끝난다", async () => {
    const dataDir = await tmp();
    await expect(collectSeoul({ places: [], cfg, key: "k", dataDir, now, fetchText: async () => "" })).rejects.toThrow("비어 있음");
  });

  it("전부 실패해도 이번 시간대는 '시도함'으로 기록돼 중복 실행이 상한을 소모하지 않는다", async () => {
    const dataDir = await tmp();
    const ps: Place[] = [{ areaCd: "POI001", areaNm: "a", category: "공원" }];
    expect(await attemptedThisHour(dataDir, now)).toBe(false);
    await collectSeoul({ places: ps, cfg, key: "k", dataDir, now, fetchText: async () => "<RESULT><CODE>INFO-100</CODE></RESULT>" });
    expect(await attemptedThisHour(dataDir, now)).toBe(true);
    expect(await attemptedThisHour(dataDir, new Date(now.getTime() + 3600_000))).toBe(false);
  });

  it("HTTP 오류 본문에 코드가 없으면 상태 코드로 구분해 남긴다", async () => {
    vi.stubGlobal("fetch", async () => ({ ok: false, status: 429, text: async () => "<html>Too Many</html>" }));
    await expect(fetchText("http://x", 1000)).rejects.toMatchObject({ name: "HTTP_429" });
  });

  afterEach(() => vi.unstubAllGlobals());
});

describe("data.go.kr 연결 실패 (2026-10-12 build 9건 TypeError)", () => {
  it("연결 실패는 한 번 다시 시도하고, 그래도 실패하면 원인 코드를 NET_ 로 남긴다", async () => {
    const { datagokr } = await import("../src/lib/datagokr.js");
    const orig = globalThis.fetch;
    let n = 0;
    globalThis.fetch = (async () => {
      n++;
      throw Object.assign(new TypeError("fetch failed"), { cause: { code: "UND_ERR_CONNECT_TIMEOUT" } });
    }) as typeof fetch;
    vi.useFakeTimers();
    try {
      const p = datagokr("k")("/x", {}).catch((e) => e);
      await vi.runAllTimersAsync();
      expect((await p).name).toBe("NET_UND_ERR_CONNECT_TIMEOUT");
      expect(n).toBe(2);
    } finally {
      vi.useRealTimers();
      globalThis.fetch = orig;
    }
  });
});
