// 점이 다각형 안에 있는지(광선 교차) — 행정동 경계로 장소의 소속 행정동을 찾는다(FR-DATA-05). 좌표는 [경도, 위도]
type Ring = [number, number][];

function inRing(x: number, y: number, ring: Ring): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

// 다각형 = [바깥 고리, 구멍 고리...]
export function inPolygons(x: number, y: number, polys: Ring[][]): boolean {
  return polys.some(([outer, ...holes]) => inRing(x, y, outer) && !holes.some((h) => inRing(x, y, h)));
}

export interface AdmDong {
  code: string;
  name: string;
  sgg: string;
  bbox: number[];
  polys: Ring[][];
}

export function findDong(lng: number, lat: number, dongs: AdmDong[]): AdmDong | null {
  for (const d of dongs) {
    const [x0, y0, x1, y1] = d.bbox;
    if (lng < x0 || lng > x1 || lat < y0 || lat > y1) continue;
    if (inPolygons(lng, lat, d.polys)) return d;
  }
  return null;
}
