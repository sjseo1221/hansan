// 화면 공통 — 자료 읽기, 날짜, 지연 안내, 하단 출처
export interface Meta {
  asOf: string;
  dates: string[];
  holidays?: string[]; // YYYY-MM-DD
  updated: Record<string, string | null>;
}
export interface Config {
  types: { id: string; label: string; desc: string }[];
  categories: { id: string; label: string }[];
  companions: { id: string; label: string; suitable: string[] }[];
  travel: { detourFactor: number; speedKmh: number; options: (number | null)[] };
  maxPerType: number;
  topN: number;
  sources: string[];
}

const cache = new Map<string, Promise<unknown>>();
// 실패한 요청은 캐시에서 지워 다음에 다시 시도한다
export function getJson<T>(path: string): Promise<T> {
  if (!cache.has(path)) {
    const p = fetch(`/data/${path}`).then((r) => {
      if (!r.ok) throw new Error(`${path}: ${r.status}`);
      return r.json();
    });
    p.catch(() => cache.delete(path));
    cache.set(path, p);
  }
  return cache.get(path) as Promise<T>;
}

export const meta = () => getJson<Meta>("meta.json");
export const config = () => getJson<Config>("config.json");

// KST 오늘 날짜
export function todayKst(): string {
  return new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 10);
}
export const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
export const weekday = (d: string) => new Date(`${d}T00:00:00Z`).getUTCDay();
const WD = "일월화수목금토";
export const dateLabel = (d: string) => `${Number(d.slice(5, 7))}월 ${Number(d.slice(8, 10))}일(${WD[weekday(d)]})`;

import { esc, isStale, LH_TEXT } from "../../../pipeline/src/shared/ui";
export { esc, LH_TEXT };

const fmt = (iso: string | null | undefined) => (iso ? `${iso.slice(0, 10)} ${iso.slice(11, 16)}` : "알 수 없음");

// 자료 기준 일시와 지연 안내(3일 넘게 갱신 안 됨)
export async function initFrame() {
  const asof = document.getElementById("asof")!;
  const stale = document.getElementById("stale")!;
  try {
    const [m, c] = await Promise.all([meta(), config()]);
    asof.textContent = `자료 기준: 혼잡 예측 ${fmt(m.updated.forecast)}, 서울 실시간 인구 ${fmt(m.updated.seoul)}, 검색 추이 ${fmt(m.updated.search)} (계산 ${m.asOf})`;
    // 계산은 수집이 실패해도 매일 돌므로 계산일이 아니라 원자료 수집 시각으로 판단한다 (NFR-REL-02: 3일 넘게)
    if (isStale(m, todayKst())) {
      stale.hidden = false;
      stale.textContent = "자료가 3일 넘게 갱신되지 않았습니다. 추천이 실제와 많이 다를 수 있어요.";
    }
    document.getElementById("sources")!.innerHTML = c.sources.map((s) => `<li>${esc(s)}</li>`).join("");
  } catch {
    asof.textContent = "자료를 불러오지 못했습니다. 잠시 뒤 다시 열어 주세요.";
  }
}
