// 좌표 → 행정동 (FR-DATA-05)
import { describe, expect, it } from "vitest";
import { findDong, inPolygons } from "../src/shared/geo.js";

const square = (x0: number, y0: number, s: number): [number, number][] => [
  [x0, y0],
  [x0 + s, y0],
  [x0 + s, y0 + s],
  [x0, y0 + s],
  [x0, y0],
];

describe("점-다각형", () => {
  it("바깥 고리 안이면 참, 구멍 안이면 거짓", () => {
    const poly = [[square(0, 0, 10), square(4, 4, 2)]];
    expect(inPolygons(1, 1, poly)).toBe(true);
    expect(inPolygons(5, 5, poly)).toBe(false);
    expect(inPolygons(11, 1, poly)).toBe(false);
  });
  it("여러 조각(MultiPolygon) 중 하나에 들면 그 행정동", () => {
    const dongs = [
      { code: "41111560", name: "경기도 수원시장안구 파장동", sgg: "41111", bbox: [0, 0, 30, 10], polys: [[square(0, 0, 10)], [square(20, 0, 10)]] },
      { code: "41111566", name: "경기도 수원시장안구 율천동", sgg: "41111", bbox: [10, 0, 20, 10], polys: [[square(10, 0, 10)]] },
    ];
    expect(findDong(25, 5, dongs)?.code).toBe("41111560");
    expect(findDong(15, 5, dongs)?.code).toBe("41111566");
    expect(findDong(50, 50, dongs)).toBeNull();
  });
});
