// 경기도 유동인구 시군구·행정동별 시간대별 집계 (FR-DATA-05) — 공공데이터포털 15151641, 1회성 CSV(564,751행, 2025-11 등록).
// 경기데이터드림이 자동 다운로드를 보안 정책으로 막아(2026-10-12 확인) 사람이 받아 data/sources/gg/ 에 두면 이 도구가 가공한다.
// 열 이름은 포털 설명 기준: 기준년월·시간대코드·행정동코드·행정동명·유동인구수 … (실제 파일로 다시 확인할 것)
// 결과: 시간대별 상대 유동인구(그 단위의 최댓값 = 1) — 행정동 단위와, 장소 연결용 시·군·구 단위(행정동코드 앞 5자리) 두 가지
export interface PatternFile {
  source: string;
  months: string[];
  slots: string[];
  sigungu: Record<string, Record<string, number>>;
  adminDong: Record<string, { name: string; pattern: Record<string, number> }>;
}

// 따옴표 안 쉼표를 지키는 최소 CSV 줄 분리
export function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (q && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else q = !q;
    } else if (ch === "," && !q) {
      out.push(cur);
      cur = "";
    } else cur += ch;
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

const normalize = (m: Map<string, number>) => {
  const max = Math.max(...m.values(), 0);
  return Object.fromEntries([...m].sort(([a], [b]) => a.localeCompare(b, undefined, { numeric: true })).map(([k, v]) => [k, max ? Math.round((v / max) * 1e4) / 1e4 : 0]));
};

export function buildPattern(lines: Iterable<string>, source: string): PatternFile {
  let header: string[] | null = null;
  let col: Record<string, number> = {};
  const dong = new Map<string, { name: string; slots: Map<string, number> }>();
  const sg = new Map<string, Map<string, number>>();
  const months = new Set<string>();
  const slots = new Set<string>();
  for (const raw of lines) {
    const line = raw.replace(/^﻿/, "");
    if (!line.trim()) continue;
    const f = splitCsvLine(line);
    if (!header) {
      header = f;
      col = Object.fromEntries(f.map((h, i) => [h, i]));
      for (const need of ["기준년월", "시간대코드", "행정동코드", "행정동명", "유동인구수"]) {
        if (!(need in col)) throw new Error(`열 없음: ${need} (실제 열: ${f.join(", ")})`);
      }
      continue;
    }
    const code = f[col["행정동코드"]];
    const slot = f[col["시간대코드"]];
    const n = Number(f[col["유동인구수"]]);
    if (!code || !slot || !Number.isFinite(n)) continue;
    months.add(f[col["기준년월"]]);
    slots.add(slot);
    // 월이 여러 개면 합산한다 — 상대 패턴만 쓰므로 월 평균과 같은 결과
    const d = dong.get(code) ?? dong.set(code, { name: f[col["행정동명"]], slots: new Map() }).get(code)!;
    d.slots.set(slot, (d.slots.get(slot) ?? 0) + n);
    const s = sg.get(code.slice(0, 5)) ?? sg.set(code.slice(0, 5), new Map()).get(code.slice(0, 5))!;
    s.set(slot, (s.get(slot) ?? 0) + n);
  }
  if (!header) throw new Error("빈 파일");
  return {
    source,
    months: [...months].sort(),
    slots: [...slots].sort((a, b) => a.localeCompare(b, undefined, { numeric: true })),
    sigungu: Object.fromEntries([...sg].map(([k, m]) => [k, normalize(m)])),
    adminDong: Object.fromEntries([...dong].map(([k, d]) => [k, { name: d.name, pattern: normalize(d.slots) }])),
  };
}
