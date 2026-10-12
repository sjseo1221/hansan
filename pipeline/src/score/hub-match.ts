// 중심 관광지(티맵 내비 기반, FR-DATA-14) ↔ 장소 연결. 이름이 같거나(정규화) 한쪽이 다른 쪽을 포함하면 3km 안에서,
// 이름이 다르면 150m 안 가장 가까운 장소에 붙인다. 한 장소에 여럿 붙으면 가장 높은 순위
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
  const stats = { items: items.length, byName: 0, byDistance: 0, unmatched: 0 };
  for (const h of items) {
    if (!Number.isFinite(h.lat) || !Number.isFinite(h.lng)) {
      stats.unmatched++;
      continue;
    }
    const hn = norm(h.name);
    const near = places.map((p) => ({ p, km: distanceKm(p, h) })).filter((x) => x.km <= 3);
    const named = near
      .filter(({ p }) => {
        const pn = norm(p.name);
        if (pn === hn) return true;
        const [s, l] = pn.length <= hn.length ? [pn, hn] : [hn, pn];
        return s.length >= 3 && l.includes(s);
      })
      .sort((a, b) => a.km - b.km);
    let hit = named[0]?.p;
    if (hit) stats.byName++;
    else {
      hit = near.filter((x) => x.km <= 0.15).sort((a, b) => a.km - b.km)[0]?.p;
      if (hit) stats.byDistance++;
      else stats.unmatched++;
    }
    if (!hit) continue;
    const prev = out.get(hit.placeId);
    if (!prev || h.rank < prev.rank) out.set(hit.placeId, { rank: h.rank, signguCd: h.signguCd, name: h.name });
  }
  return { ranks: out, stats };
}
