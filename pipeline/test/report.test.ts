// 주간 품질 리포트 계산 시험 (FR-OPS-02·03·08)
import { describe, expect, it } from "vitest";
import { accuracy, typeCounts, usageWarnings } from "../src/report/weekly.js";
import { isoWeek, mondayOf, shiftWeek } from "../src/score/exposure.js";

describe("예측 적중률 (FR-OPS-03)", () => {
  const cfg = { quietLevels: ["여유"], hours: [10, 18] as [number, number] };
  const row = (area: string, t: string, lv: string) => ({ areaCd: area, congestLvl: lv, ppltnTime: `2026-10-17 ${t}` });
  it("'높음' 추천 중 실측 있는 것만 평가, 방문 시간대 과반이 '여유'면 적중, 실측 없는 건 빼고 센다", () => {
    const logs = [
      {
        date: "2026-10-17",
        items: [
          { id: "a", rep: "timing_game", lh: "high", seoul: "P1" },
          { id: "b", rep: "timing_game", lh: "high", seoul: "P2" },
          { id: "c", rep: "moderate_hotspot", lh: "high" }, // 실측 없음
          { id: "d", rep: "moderate_hotspot", lh: "medium", seoul: "P1" }, // 높음 아님
        ],
      },
    ];
    const rows = [row("P1", "10:00", "여유"), row("P1", "13:00", "여유"), row("P1", "16:00", "붐빔"), row("P2", "11:00", "붐빔"), row("P2", "12:00", "보통"), row("P2", "14:00", "붐빔"), row("P1", "08:00", "붐빔"), row("P2", "20:00", "여유")];
    expect(accuracy(logs, rows, cfg)).toEqual({ recommendedHigh: 3, evaluable: 2, excluded: 1, quiet: 1, rate: 50 });
    expect(typeCounts(logs)).toEqual({ timing_game: 2, moderate_hotspot: 2 });
  });
  it("방문 시간대 실측이 3건 미만이면 평가에서 뺀다", () => {
    const logs = [{ date: "2026-10-17", items: [{ id: "a", rep: "timing_game", lh: "high", seoul: "P1" }] }];
    expect(accuracy(logs, [row("P1", "10:00", "여유"), row("P1", "11:00", "여유")], cfg)).toMatchObject({ evaluable: 0, excluded: 1 });
  });
  it("평가할 건이 없으면 적중률은 null", () => {
    expect(accuracy([{ date: "2026-10-17", items: [{ id: "a", rep: null, lh: "high" }] }], [], cfg).rate).toBeNull();
  });
});

describe("80% 경고 (FR-OPS-08)", () => {
  it("하루 한도는 카운터 합의 가장 많은 날, 월 한도는 이번 달 누적", () => {
    const w = usageWarnings(
      { a: { "2026-10-12": 500, "2026-10-13": 100 }, b: { "2026-10-12": 300 }, t: {} },
      { svc: { limit: 1000, per: "day", counters: ["a", "b"] }, tr: { limit: 1000, per: "month", counters: ["t"] } },
      { t: 790 },
    );
    expect(w[0]).toMatchObject({ service: "svc", used: 800, pct: 80, warn: true });
    expect(w[1]).toMatchObject({ service: "tr", used: 790, warn: false });
  });
});

describe("주 계산", () => {
  it("지난주·월요일", () => {
    expect(shiftWeek(isoWeek("2026-10-12"), -1)).toBe("2026-W41");
    expect(mondayOf("2026-W41")).toBe("2026-10-05");
    expect(mondayOf("2026-W53")).toBe("2026-12-28");
  });
});
