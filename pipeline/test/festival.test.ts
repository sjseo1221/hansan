// 축제(2026-10-12 사용자 요청: 정기 축제) — 요일 해석, 날짜별 표시, 출처 합치기
import { describe, expect, it } from "vitest";
import { activeOn, mergeFestivals, weekdaysOf, type Festival } from "../src/collect/festival.js";

const fest = (o: Partial<Festival>): Festival => ({ id: "x", src: "tour", title: "축제", place: "", lat: 37.5, lng: 127, start: "20260906", end: "20261025", ...o });

describe("정기 축제 요일", () => {
  it("'매주 일요일 13:00~21:00' → 일요일, '매주 토·일요일' → 토·일, 없으면 매일", () => {
    expect(weekdaysOf("매주 일요일 13:00 ~ 21:00")).toEqual([0]);
    expect(weekdaysOf("매주 토·일요일 10시")).toEqual([0, 6]);
    expect(weekdaysOf("10:00~18:00")).toBeUndefined();
  });
  it("기간 안이고 요일이 맞을 때만 그 날 열림", () => {
    const f = fest({ weekdays: [0] });
    expect(activeOn(f, "20261018", 0)).toBe(true); // 일
    expect(activeOn(f, "20261017", 6)).toBe(false); // 토
    expect(activeOn(f, "20261101", 0)).toBe(false); // 기간 밖
    expect(activeOn(fest({}), "20261017", 6)).toBe(true);
  });
});

describe("출처 합치기", () => {
  it("이름이 같거나 포함(4자 이상)하고 1km 안이면 하나만 — 앞 출처(운영자 파일)가 남는다", () => {
    const m = mergeFestivals(
      [fest({ id: "manual-0", src: "manual", title: "2026 차 없는 잠수교 뚜벅뚜벅 축제(가을)" })],
      [fest({ id: "seoul-1", src: "seoul", title: "[미래한강본부] 2026 차없는 잠수교 뚜벅뚜벅 축제", lat: 37.501, lng: 127.0 })],
      [fest({ id: "tour-1", title: "한강페스티벌", lat: 37.52, lng: 126.93 })],
    );
    expect(m.map((x) => x.id)).toEqual(["manual-0", "tour-1"]);
  });
  it("이름이 같아도 멀리 떨어져 있으면 다른 축제", () => {
    expect(mergeFestivals([fest({ title: "국화축제" })], [fest({ id: "y", title: "국화축제", lat: 36.0, lng: 128.0 })])).toHaveLength(2);
  });
});
