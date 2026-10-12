// 주간 품질 리포트 계산(FR-OPS-02·03·08) — 파일 입출력 없이 순수 함수로(시험용)

export interface RecLog {
  date: string;
  items: { id: string; rep: string | null; lh: string | null; seoul?: string }[];
}
export interface SeoulRow {
  areaCd: string;
  congestLvl: string;
  ppltnTime: string; // "YYYY-MM-DD HH:mm"
}

// 예측 적중률: '높음'으로 추천한 장소·날짜 중 실제 혼잡 단계가 방문 시간대에 주로 한산이었던 비율. 실측 없는 건 빼고 수를 센다
export function accuracy(logs: RecLog[], rows: SeoulRow[], cfg: { quietLevels: string[]; hours: [number, number]; minRows?: number }) {
  const byKey = new Map<string, string[]>();
  for (const r of rows) {
    const h = Number(r.ppltnTime.slice(11, 13));
    if (h < cfg.hours[0] || h >= cfg.hours[1]) continue;
    const k = `${r.areaCd}|${r.ppltnTime.slice(0, 10)}`;
    (byKey.get(k) ?? byKey.set(k, []).get(k)!).push(r.congestLvl);
  }
  let high = 0;
  let evaluable = 0;
  let quiet = 0;
  for (const log of logs)
    for (const it of log.items) {
      if (it.lh !== "high") continue;
      high++;
      const lv = it.seoul ? byKey.get(`${it.seoul}|${log.date}`) : undefined;
      // 방문 시간대 실측이 너무 적으면 평가하지 않는다
      if (!lv || lv.length < (cfg.minRows ?? 3)) continue;
      evaluable++;
      if (lv.filter((x) => cfg.quietLevels.includes(x)).length * 2 > lv.length) quiet++;
    }
  return { recommendedHigh: high, evaluable, excluded: high - evaluable, quiet, rate: evaluable ? Math.round((quiet / evaluable) * 1000) / 10 : null };
}

// 유형별 추천 수(날짜별 합)
export function typeCounts(logs: RecLog[]) {
  const out: Record<string, number> = {};
  for (const l of logs) for (const it of l.items) if (it.rep) out[it.rep] = (out[it.rep] ?? 0) + 1;
  return out;
}

// 외부 서비스 사용량 대비 무료 한도 — 80% 이상이면 경고(FR-OPS-08). 하루 한도는 주중 가장 많이 쓴 날, 월 한도는 그 달 누적
export function usageWarnings(
  used: Record<string, Record<string, number>>, // 카운터 → 날짜 → 호출 수
  limits: Record<string, { limit: number; per: "day" | "month"; counters: string[]; note?: string }>,
  monthUsed: Record<string, number>, // 카운터 → 이번 달 누적
) {
  return Object.entries(limits).map(([service, l]) => {
    let peak = 0;
    if (l.per === "day") {
      const days = new Set(l.counters.flatMap((c) => Object.keys(used[c] ?? {})));
      for (const d of days) peak = Math.max(peak, l.counters.reduce((n, c) => n + (used[c]?.[d] ?? 0), 0));
    } else peak = l.counters.reduce((n, c) => n + (monthUsed[c] ?? 0), 0);
    const pct = Math.round((peak / l.limit) * 1000) / 10;
    return { service, per: l.per, used: peak, limit: l.limit, pct, warn: pct >= 80, ...(l.note ? { note: l.note } : {}) };
  });
}
