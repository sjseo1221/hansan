// 화면 공통 로직 시험 — 이동 시간(FR-FLT-02)·필터(03·04)·피드 묶음과 정렬(FR-FEED-02·04)·완화 제안(FR-FLT-06)
import { describe, expect, it } from "vitest";
import { distanceKm, groupFeed, matches, relaxations, ruleReason, travelMinutes, type FeedItem, type Filters } from "../src/shared/feed.js";

const cfg = {
  travel: { detourFactor: 1.3, speedKmh: 40 },
  companions: [{ id: "kids", label: "아이 동반", suitable: ["nature_park"] }],
  maxPerType: 10,
  topN: 3,
};
const item = (o: Partial<FeedItem>): FeedItem => ({ id: "a", name: "a", area: "서울 종로구", cat: "nature_park", indoor: "outdoor", lat: 37.57, lng: 126.98, rep: "moderate_hotspot", types: ["moderate_hotspot"], lh: "medium", pop: 80, f: 50, u: null, trend: null, lt: null, ...o });
const F: Filters = { date: "2026-10-17", origin: null, minutes: null, companion: null, indoor: null };

describe("이동 시간·필터", () => {
  it("서울시청~수원시청 직선 약 31km → ×1.3 ÷ 40km/h ≈ 61분", () => {
    const km = distanceKm({ lat: 37.5665, lng: 126.978 }, { lat: 37.2636, lng: 127.0286 });
    expect(km).toBeGreaterThan(33);
    expect(km).toBeLessThan(35);
    expect(travelMinutes(km, cfg.travel)).toBe(Math.round(((km * 1.3) / 40) * 60));
  });
  it("이동 시간 초과·동행 부적합·실내외 불일치는 거른다. 실내외 혼합은 어느 쪽이든 남는다", () => {
    const origin = { lat: 37.5665, lng: 126.978 };
    const far = item({ lat: 37.2636, lng: 127.0286 });
    expect(matches(far, { ...F, minutes: 30 }, origin, cfg)).toBe(false);
    expect(matches(far, { ...F, minutes: 120 }, origin, cfg)).toBe(true);
    expect(matches(item({ cat: "heritage" }), { ...F, companion: "kids" }, null, cfg)).toBe(false);
    expect(matches(item({ indoor: "outdoor" }), { ...F, indoor: "indoor" }, null, cfg)).toBe(false);
    expect(matches(item({ indoor: "mixed" }), { ...F, indoor: "indoor" }, null, cfg)).toBe(true);
  });
});

describe("피드 묶음", () => {
  it("대표 유형으로 한 번만, 한산 가능성 → 인기도 순, 유형당 최대 10곳", () => {
    const items = [item({ id: "x", lh: "medium", pop: 99 }), item({ id: "y", lh: "high", pop: 10 }), item({ id: "z", lh: "high", pop: 50 }), item({ id: "t", rep: "timing_game", types: ["timing_game", "moderate_hotspot"] })];
    const g = groupFeed(items, cfg);
    expect(g.moderate_hotspot.map((x) => x.id)).toEqual(["z", "y", "x"]);
    expect(g.timing_game.map((x) => x.id)).toEqual(["t"]);
    expect(groupFeed(Array.from({ length: 12 }, (_, i) => item({ id: `p${String(i).padStart(2, "0")}` })), cfg).moderate_hotspot).toHaveLength(10);
  });
  it("연속 노출 제한 장소는 상위 3에 두지 않는다", () => {
    const items = ["a", "b", "c", "d"].map((id, i) => item({ id, pop: 90 - i, ...(id === "a" ? { blocked: ["moderate_hotspot" as const] } : {}) }));
    expect(groupFeed(items, cfg).moderate_hotspot.map((x) => x.id)).toEqual(["b", "c", "d", "a"]);
  });
  it("조건을 하나씩 풀었을 때 남는 수를 많은 순으로 제안", () => {
    const items = [item({ cat: "heritage", indoor: "indoor" }), item({ id: "b", cat: "heritage", indoor: "outdoor" })];
    const r = relaxations(items, { ...F, companion: "kids", indoor: "indoor" }, null, cfg);
    expect(r).toEqual([{ key: "companion", count: 1 }]);
  });
});

describe("규칙 근거 문장", () => {
  it("유형별 수치를 쉬운 말로", () => {
    expect(ruleReason(item({ u: 80, f: 55 }), "timing_game")).toContain("25만큼 낮아요");
    expect(ruleReason(item({ trend: 1.5 }), "early_hotspot")).toContain("150%");
    expect(ruleReason(item({ slot: { start: "09:00", end: "11:00", quietToPeak: 0.42 } }), "time_slot")).toContain("09:00~11:00");
  });
});
