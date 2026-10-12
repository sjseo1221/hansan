// 점수 계산 공통 — 결정적이어야 한다(같은 입력 → 같은 결과). 시각은 인자로만 받는다
export const r1 = (v: number) => Math.round(v * 10) / 10;
export const r3 = (v: number) => Math.round(v * 1000) / 1000;
export const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
export const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);

export function median(xs: number[]): number {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

// 백분위 0~100: 100 × (작은 값 수 + (같은 값 수 − 1)/2) / (N − 1). 같은 값은 같은 백분위, N=1 이면 50
export function percentiles(values: Map<string, number>): Map<string, number> {
  const sorted = [...values.values()].sort((a, b) => a - b);
  const n = sorted.length;
  const out = new Map<string, number>();
  for (const [k, v] of values) {
    if (n === 1) {
      out.set(k, 50);
      continue;
    }
    let lo = 0;
    let hi = n;
    while (lo < hi) {
      const m = (lo + hi) >> 1;
      if (sorted[m] < v) lo = m + 1;
      else hi = m;
    }
    const less = lo;
    let eq = 0;
    for (let i = lo; i < n && sorted[i] === v; i++) eq++;
    out.set(k, r1((100 * (less + (eq - 1) / 2)) / (n - 1)));
  }
  return out;
}

// raw 파일의 같은 키 중복 줄(같은 날 여러 번 실행) — fetchedAt 이 가장 늦은 줄만 쓴다
export function latestBy<T extends { fetchedAt?: string }>(rows: T[], key: (r: T) => string): Map<string, T> {
  const out = new Map<string, T>();
  for (const r of rows) {
    const k = key(r);
    const prev = out.get(k);
    if (!prev || (r.fetchedAt ?? "") >= (prev.fetchedAt ?? "")) out.set(k, r);
  }
  return out;
}

// 날짜 문자열 도우미 (YYYY-MM-DD, UTC 자정 기준으로만 계산해 시간대 영향을 없앤다)
export const dayMs = 86400000;
export const compact = (d: string) => d.replaceAll("-", "");
// "YYYY-MM-DD" · "YYYYMMDD" 모두 받는다
export const toDate = (d: string) => {
  const c = compact(d);
  return new Date(`${c.slice(0, 4)}-${c.slice(4, 6)}-${c.slice(6, 8)}T00:00:00Z`);
};
export const ymd = (d: Date) => d.toISOString().slice(0, 10);
export const addDays = (d: string, n: number) => ymd(new Date(toDate(d).getTime() + n * dayMs));
export const weekday = (d: string) => toDate(d).getUTCDay(); // 0 = 일요일
