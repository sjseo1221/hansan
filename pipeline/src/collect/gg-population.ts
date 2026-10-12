// 경기도 유동인구 행정동 단위 집계 (FR-DATA-05) — 경기데이터드림 '유동인구_행정동 단위 집계', 1회성 CSV.
// 경기데이터드림이 자동 다운로드를 보안 정책으로 막아(2026-10-12 확인) 사람이 받아 data/sources/gg/ 에 두면 이 도구가 가공한다.
// 실제 파일(2026-10-12 확인, 202601-202603 zip): 월·시군별 파일 T22_GG_ADMI_FLOWPOP_<YYYYMM>_<시군>.csv, UTF-8(BOM), 16개 시군.
// 열: ADMI_CD(행정동 8자리)·CTY_NM·ADMI_NM·TIME_CD(00~23)·FORN_GB(N 내국인·F 외국인)·M_10_CNT … F_70_CNT(성·연령별 인구)·ETL_YMD
// 결과: 시간대별 상대 유동인구(그 단위의 최댓값 = 1) — 행정동 단위와, 장소 연결용 시·군·구 단위(행정동코드 앞 5자리) 두 가지
export interface PatternFile {
  source: string;
  skippedRows: number;
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

// 파일을 하나씩 더하고(add) 마지막에 결과를 만든다 — 48개 파일·약 150만 행을 한꺼번에 메모리에 올리지 않는다
export class PatternBuilder {
  private dong = new Map<string, { name: string; slots: Map<string, number> }>();
  private sg = new Map<string, Map<string, number>>();
  private months = new Set<string>();
  private slots = new Set<string>();
  private skipped = 0;

  // 파일 하나(머리글 포함). month 는 파일 이름의 YYYYMM — 파일 안에는 기준년월 열이 없다
  add(lines: Iterable<string>, month: string) {
    let col: Record<string, number> | null = null;
    let counts: number[] = [];
    for (const raw of lines) {
      const line = raw.replace(/^﻿/, "");
      if (!line.trim()) continue;
      const f = splitCsvLine(line);
      if (!col) {
        col = Object.fromEntries(f.map((h, i) => [h, i]));
        for (const need of ["ADMI_CD", "ADMI_NM", "TIME_CD"]) {
          if (!(need in col)) throw new Error(`열 없음: ${need} (실제 열: ${f.join(", ")}) — 열 이름이 깨져 보이면 파일이 EUC-KR 이니 UTF-8 로 바꿔 저장하세요`);
        }
        // 성·연령별 인구 열을 모두 더한 값이 그 행정동·시간대의 유동인구
        counts = f.flatMap((h, i) => (/^[MF]_\d+_CNT$/.test(h) ? [i] : []));
        if (!counts.length) throw new Error(`열 없음: M_*_CNT/F_*_CNT (실제 열: ${f.join(", ")})`);
        continue;
      }
      const code = f[col["ADMI_CD"]];
      const slot = f[col["TIME_CD"]];
      // 천 단위 쉼표를 지우고, 빈 값·"-" 는 0 으로 세지 않고 건너뛴다(2차 리뷰). 한 칸이라도 숫자가 아니면 행을 건너뛴다
      let n = 0;
      for (const i of counts) {
        const v = (f[i] ?? "").replaceAll(",", "");
        n += v === "" || v === "-" ? NaN : Number(v);
      }
      if (!code || !slot || !Number.isFinite(n)) {
        this.skipped++;
        continue;
      }
      this.months.add(month);
      this.slots.add(slot);
      // 월·내외국인 구분은 합산한다 — 상대 패턴만 쓰므로 월 평균과 같은 결과
      const d = this.dong.get(code) ?? this.dong.set(code, { name: f[col["ADMI_NM"]], slots: new Map() }).get(code)!;
      d.slots.set(slot, (d.slots.get(slot) ?? 0) + n);
      // 일반구가 있는 시는 시 코드(앞 4자리 + 0)로도 합산한다 — 장소는 시 코드(화성 41590)인데 유동인구는 일반구(41591~41597)인 경우
      const k = code.slice(0, 5);
      for (const key of new Set([k, `${k.slice(0, 4)}0`])) {
        const s = this.sg.get(key) ?? this.sg.set(key, new Map()).get(key)!;
        s.set(slot, (s.get(slot) ?? 0) + n);
      }
    }
    if (!col) throw new Error("빈 파일");
  }

  result(source: string): PatternFile {
    return {
      source,
      skippedRows: this.skipped,
      months: [...this.months].sort(),
      slots: [...this.slots].sort((a, b) => a.localeCompare(b, undefined, { numeric: true })),
      sigungu: Object.fromEntries([...this.sg].map(([k, m]) => [k, normalize(m)])),
      adminDong: Object.fromEntries([...this.dong].map(([k, d]) => [k, { name: d.name, pattern: normalize(d.slots) }])),
    };
  }
}
