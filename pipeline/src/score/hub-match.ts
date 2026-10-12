// 중심 관광지(티맵 내비 기반, FR-DATA-14) ↔ 장소 연결. 이름이 같으면(정규화) 3km, 한쪽이 다른 쪽을 포함하면 1km 안에서만 붙인다.
// 거리만으로는 붙이지 않는다 — 도심에서 호텔·쇼핑몰이 옆 박물관에 붙는 오연결이 많았다(2026-10-12 표본). 숙박은 장소 분류에 없어 뺀다.
// 한 장소에 여럿 붙으면 가장 높은 순위
import type { HubItem } from "../collect/hub.js";
import { norm } from "../places/match.js";
import { distanceKm } from "../shared/feed.js";

export interface PlaceLite {
  placeId: string;
  name: string;
  lat: number;
  lng: number;
}

export function matchHub(places: PlaceLite[], items: HubItem[]) {
  const out = new Map<string, { rank: number; signguCd: string; name: string }>();
  const stats = { items: items.length, lodging: 0, byName: 0, unmatched: 0 };
  for (const h of items) {
    if (h.lcls === "숙박") {
      stats.lodging++;
      continue;
    }
    if (!Number.isFinite(h.lat) || !Number.isFinite(h.lng)) {
      stats.unmatched++;
      continue;
    }
    const hn = norm(h.name);
    const near = places.map((p) => ({ p, km: distanceKm(p, h) })).filter((x) => x.km <= 3);
    const named = near
      .filter(({ p, km }) => {
        const pn = norm(p.name);
        if (pn === hn) return true;
        // 포함 관계는 1km 안만 — 3km 까지 보면 '○○박물관'이 근처 다른 장소 '○○'에 붙었다(2026-10-12 표본)
        const [s, l] = pn.length <= hn.length ? [pn, hn] : [hn, pn];
        return km <= 1 && s.length >= 3 && l.includes(s);
      })
      .sort((a, b) => a.km - b.km);
    const hit = named[0]?.p;
    if (!hit) {
      stats.unmatched++;
      continue;
    }
    stats.byName++;
    const prev = out.get(hit.placeId);
    if (!prev || h.rank < prev.rank) out.set(hit.placeId, { rank: h.rank, signguCd: h.signguCd, name: h.name });
  }
  return { ranks: out, stats };
}
