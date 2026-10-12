import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { collectEvents, collectOperation, collectVisitors, summarize, toGrid } from "../src/collect/supplement.js";
import type { DgGet } from "../src/lib/datagokr.js";
import { DailyUsage } from "../src/lib/usage.js";

const tmp = () => mkdtemp(join(tmpdir(), "hansan-aux-"));
const now = new Date("2026-10-12T03:00:00Z"); // KST 2026-10-12 12:00
const usage = async (dir: string, cap = 100) => DailyUsage.load(dir, "x", "2026-10-12", cap);

describe("기상청 격자 변환", () => {
  it("서울시청 좌표는 격자 (60, 127) — 2026-10-11 probe 에서 쓴 서울 격자와 같다", () => {
    expect(toGrid(37.5665, 126.978)).toEqual({ nx: 60, ny: 127 });
  });
});

describe("단기예보 요약", () => {
  it("날짜별 최고·최저·최대 강수확률·정오 하늘·강수 여부", () => {
    const s = summarize([
      { category: "TMX", fcstDate: "20261013", fcstTime: "1500", fcstValue: "24.0" },
      { category: "TMN", fcstDate: "20261013", fcstTime: "0600", fcstValue: "12.0" },
      { category: "POP", fcstDate: "20261013", fcstTime: "0900", fcstValue: "20" },
      { category: "POP", fcstDate: "20261013", fcstTime: "1500", fcstValue: "60" },
      { category: "PTY", fcstDate: "20261013", fcstTime: "1500", fcstValue: "1" },
      { category: "SKY", fcstDate: "20261013", fcstTime: "1200", fcstValue: "4" },
    ]);
    expect(s["20261013"]).toEqual({ tmx: 24, tmn: 12, popMax: 60, rain: true, sky12: "4" });
  });
});

describe("방문자수", () => {
  it("첫 실행은 lookback 부터 어제까지, 대상 시·도만 압축해 월별로 쌓고, 다음 실행은 마지막 날 다음부터 받는다", async () => {
    const dataDir = await tmp();
    const calls: Record<string, string>[] = [];
    const get: DgGet = async (_p, params) => {
      calls.push(params);
      return {
        totalCount: 3,
        items: [
          { baseYmd: "20260830", signguCode: "11110", daywkDivCd: "7", touDivCd: "1", touNum: "1000.0" },
          { baseYmd: "20260909", signguCode: "11110", daywkDivCd: "3", touDivCd: "2", touNum: "50" },
          { baseYmd: "20260909", signguCode: "26110", daywkDivCd: "3", touDivCd: "1", touNum: "9" },
        ],
      };
    };
    const r = await collectVisitors({ get, usage: await usage(dataDir), provinces: ["11"], dataDir, now, firstLookbackDays: 60 });
    expect(r).toEqual({ rows: 2, lastDate: "20260909" });
    expect(calls[0]).toMatchObject({ startYmd: "20260813", endYmd: "20261011" });
    const aug = (await readFile(join(dataDir, "raw", "visitors", "2026-08.jsonl"), "utf8")).trim();
    expect(JSON.parse(aug)).toEqual({ d: "20260830", s: "11110", w: "7", t: "1", n: 1000 });

    // 다음 실행은 마지막 저장일 '포함'해서 다시 받되(부분 공개일 보강), 이미 쌓인 행은 중복으로 붙이지 않는다
    const r2 = await collectVisitors({ get, usage: await usage(dataDir), provinces: ["11"], dataDir, now, firstLookbackDays: 60 });
    expect(calls[1]).toMatchObject({ startYmd: "20260909" });
    expect(r2.rows).toBe(0);
    expect((await readFile(join(dataDir, "raw", "visitors", "2026-09.jsonl"), "utf8")).trim().split("\n")).toHaveLength(1);
  });
});

describe("날씨 (2차 리뷰: 발표 전 요청·빈 응답이 직전 값을 지우던 문제)", () => {
  it("중기예보 발표 시각: 05:40 이면 전날 18시, 07:00 이면 당일 06시, 19:00 이면 당일 18시", async () => {
    const { midIssueTime } = await import("../src/collect/supplement.js");
    expect(midIssueTime(new Date("2026-10-11T20:40:00Z"))).toBe("202610111800"); // KST 10-12 05:40
    expect(midIssueTime(new Date("2026-10-11T22:00:00Z"))).toBe("202610120600"); // KST 07:00
    expect(midIssueTime(new Date("2026-10-12T10:00:00Z"))).toBe("202610121800"); // KST 19:00
  });

  it("단기·중기가 비거나 실패한 시·군·구·구역은 직전 값을 그대로 둔다", async () => {
    const { collectWeather } = await import("../src/collect/supplement.js");
    const dataDir = await tmp();
    const okGet: DgGet = async (path) =>
      path.includes("Mid")
        ? { totalCount: 1, items: [{ regId: "11B00000", wf4Am: "맑음" }] }
        : { totalCount: 1, items: [{ category: "TMX", fcstDate: "20261013", fcstTime: "1500", fcstValue: "20" }] };
    const points = [{ signguCd: "11110", lat: 37.57, lng: 126.98 }];
    await collectWeather({ get: okGet, usage: await usage(dataDir), points, midRegions: ["11B00000"], dataDir, now });
    const emptyGet: DgGet = async () => ({ totalCount: 0, items: [] });
    const r = await collectWeather({ get: emptyGet, usage: await usage(dataDir), points, midRegions: ["11B00000"], dataDir, now });
    expect(r).toMatchObject({ ok: 0, mid: 0, failed: 2 });
    const w = JSON.parse(await readFile(join(dataDir, "latest", "weather.json"), "utf8"));
    expect(w.short["11110"].days["20261013"].tmx).toBe(20);
    expect(w.mid["11B00000"].wf4Am).toBe("맑음");
  });
});

describe("행사", () => {
  it("horizon 안에 시작하는 행사만 남기고 세종 5자리 코드를 시·군·구로 쓴다", async () => {
    const dataDir = await tmp();
    const get: DgGet = async () => ({
      totalCount: 2,
      items: [
        { contentid: 1, title: "가", addr1: "", mapx: "127", mapy: "36", lDongRegnCd: "36110", eventstartdate: "20261015", eventenddate: "20261020" },
        { contentid: 2, title: "나", addr1: "", mapx: "127", mapy: "36", lDongRegnCd: "36110", eventstartdate: "20261201", eventenddate: "20261210" },
      ],
    });
    const r = await collectEvents({ get, usage: await usage(dataDir), regnParams: ["36110"], dataDir, now, horizonDays: 14 });
    expect(r.events).toBe(1);
    const f = JSON.parse(await readFile(join(dataDir, "latest", "events.json"), "utf8"));
    expect(f.events[0]).toMatchObject({ provinceCd: "36", signguCd: "36110", start: "20261015" });
  });
});

describe("운영 정보", () => {
  it("유형별 필드를 휴무·이용시간 두 칸으로 모으고 <br> 를 지운다", async () => {
    const dataDir = await tmp();
    const get: DgGet = async (_p, params) => ({
      totalCount: 1,
      items: [params.contentTypeId === "14" ? { restdateculture: "매주 월요일<br>설날", usetimeculture: "09:00~18:00" } : { restdate: "매주 화요일", usetime: "09:00~17:00" }],
    });
    const r = await collectOperation({ get, usage: await usage(dataDir), places: [{ placeId: "kto-1", contentId: "1", contentTypeId: "12" }, { placeId: "kto-2", contentId: "2", contentTypeId: "14" }], dataDir, now });
    expect(r).toMatchObject({ ok: 2, failed: 0 });
    const op = JSON.parse(await readFile(join(dataDir, "sources", "tour", "operation.json"), "utf8")).operation;
    expect(op["kto-2"]).toMatchObject({ rest: "매주 월요일 설날", hours: "09:00~18:00" });
    expect(op["kto-1"].rest).toBe("매주 화요일");

    // 빈 응답은 실패로 세고 직전 값을 지우지 않는다 (2차 리뷰)
    const empty: DgGet = async () => ({ totalCount: 0, items: [] });
    const r2 = await collectOperation({ get: empty, usage: await usage(dataDir), places: [{ placeId: "kto-1", contentId: "1", contentTypeId: "12" }], dataDir, now });
    expect(r2).toMatchObject({ ok: 0, failed: 1 });
    const op2 = JSON.parse(await readFile(join(dataDir, "sources", "tour", "operation.json"), "utf8")).operation;
    expect(op2["kto-1"].rest).toBe("매주 화요일");
  });
});

describe("경기 유동인구 CSV 가공 (FR-DATA-05)", () => {
  it("행정동·시군구 시간대 상대 패턴을 만들고, 따옴표 속 쉼표·BOM 을 처리한다", async () => {
    const { buildPattern } = await import("../src/collect/gg-population.js");
    const p = buildPattern(
      [
        "﻿기준년월,시간대코드,행정동코드,행정동명,행정동명_영문,유동인구수,유동인구수비율",
        '202508,01,4111151000,파장동,"Pajang-dong, Suwon",100,0.1',
        "202508,02,4111151000,파장동,x,400,0.4",
        "202508,01,4111152000,율천동,x,300,0.3",
        "202508,02,4111152000,율천동,x,100,0.1",
      ],
      "test",
    );
    expect(p.adminDong["4111151000"]).toEqual({ name: "파장동", pattern: { "01": 0.25, "02": 1 } });
    expect(p.sigungu["41111"]).toEqual({ "01": 0.8, "02": 1 });
    expect(p.slots).toEqual(["01", "02"]);
  });
  it("필수 열이 없으면 실제 열 이름을 알려 주며 실패한다", async () => {
    const { buildPattern } = await import("../src/collect/gg-population.js");
    expect(() => buildPattern(["a,b,c", "1,2,3"], "t")).toThrow("열 없음: 기준년월");
  });
});
