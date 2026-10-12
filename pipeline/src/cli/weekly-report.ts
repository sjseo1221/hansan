// 주간 품질 리포트(FR-OPS-02·03·08, NFR-COST-04) — 지난 ISO 주(월~일)를 정리해 data/reports/weekly/<주>.json 과 docs/reports/weekly/<주>.md 로 쓴다.
// 이미 있으면 다시 만들지 않는다(FORCE=1 이면 다시). WEEK=YYYY-Www 로 주를 고를 수 있다
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { parse } from "yaml";
import { readJson, writeJson } from "../lib/store.js";
import { kstParts } from "../lib/time.js";
import { accuracy, typeCounts, usageWarnings, type RecLog, type SeoulRow } from "../report/weekly.js";
import { isoWeek, mondayOf, shiftWeek } from "../score/exposure.js";
import { TYPE_TEXT } from "../score/public.js";
import { addDays } from "../score/stats.js";

const today = process.env.ASOF ?? kstParts(new Date()).date;
const week = process.env.WEEK ?? shiftWeek(isoWeek(today), -1);
const jsonPath = `data/reports/weekly/${week}.json`;
const mdPath = `docs/reports/weekly/${week}.md`;
// 완결된 리포트만 건너뛴다 — 이용 수·실행 시간을 못 읽은 불완전한 리포트는 다음 실행에서 다시 만든다
if (existsSync(jsonPath) && (await readJson<{ complete?: boolean }>(jsonPath, {})).complete && process.env.FORCE !== "1") {
  console.log(JSON.stringify({ skipped: `${week} 리포트가 이미 있음` }));
  process.exit(0);
}
const days = Array.from({ length: 7 }, (_, i) => addDays(mondayOf(week), i));
async function jsonl<T>(p: string): Promise<T[]> {
  if (!existsSync(p)) return [];
  return (await readFile(p, "utf8"))
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as T);
}
const yaml = async <T,>(p: string) => parse(await readFile(p, "utf8")) as T;

const thresholds = await yaml<{ accuracy: { quietLevels: string[]; hours: [number, number]; minRows: number } }>("config/thresholds.yaml");
const sources = await yaml<{ freeLimits: Parameters<typeof usageWarnings>[1] }>("config/sources.yaml");
const llmCfg = await yaml<{ budget: { monthlyUsd: number; appCutoffUsd: number }; generation: { monthlyUsd: number } }>("config/llm.yaml");

// 1) 적중률·유형별 추천 수
const logs: RecLog[] = [];
const seoul: SeoulRow[] = [];
for (const d of days) {
  const p = `data/state/rec-log/${d.slice(0, 7)}/${d.slice(8)}.json`;
  if (existsSync(p)) logs.push(await readJson<RecLog>(p, { date: d, items: [] }));
  seoul.push(...(await jsonl<SeoulRow>(`data/raw/seoul_citydata/${d.slice(0, 7)}/${d.slice(8)}.jsonl`)));
}
const acc = accuracy(logs, seoul, thresholds.accuracy);
const types = typeCounts(logs);

// 2) 수집 실패 내역
const failures: Record<string, number> = {};
for (const m of new Set(days.map((d) => d.slice(0, 7))))
  for (const f of await jsonl<{ at: string; source: string; code: string }>(`data/state/failures/${m}.jsonl`)) {
    if (!days.includes(f.at.slice(0, 10))) continue;
    const k = `${f.source} ${f.code}`;
    failures[k] = (failures[k] ?? 0) + 1;
  }

// 3) 외부 서비스 사용량(80% 경고)
const counters = new Set(Object.values(sources.freeLimits).flatMap((l) => l.counters));
const used: Record<string, Record<string, number>> = {};
const monthUsed: Record<string, number> = {};
// 월 한도: 그 주가 걸친 달마다 누적을 세고 가장 큰 달을 쓴다(달 경계 주에 앞달을 빠뜨리지 않게)
const months = [...new Set(days.map((d) => d.slice(0, 7)))];
const month = days[6].slice(0, 7);
for (const c of counters) {
  used[c] = {};
  const perMonth: Record<string, number> = {};
  const dir = `data/state/usage/${c}`;
  if (!existsSync(dir)) continue;
  for (const f of await readdir(dir)) {
    const d = f.slice(0, 10);
    const n = (await readJson<{ count: number }>(`${dir}/${f}`, { count: 0 })).count;
    if (days.includes(d)) used[c][d] = n;
    if (months.includes(d.slice(0, 7))) perMonth[d.slice(0, 7)] = (perMonth[d.slice(0, 7)] ?? 0) + n;
  }
  monthUsed[c] = Math.max(0, ...Object.values(perMonth));
}
const warnings = usageWarnings(used, sources.freeLimits, monthUsed);

// 4) OpenAI 비용 — 생성(주기 작업)은 실행 보고서, 대화는 Worker 카운터
let genWeek = 0;
if (existsSync("data/reports/llm"))
  for (const f of await readdir("data/reports/llm")) if (days.includes(f.slice(0, 10))) genWeek += (await readJson<{ run: { costUsd: number } }>(`data/reports/llm/${f}`, { run: { costUsd: 0 } })).run.costUsd;
const genMonth = (await readJson<{ costUsd: number }>(`data/state/llm/usage-${month}.json`, { costUsd: 0 })).costUsd;

// 5) 이용 집계(FR-OPS-06)·대화 비용 — 화면 Worker 에서
const site = process.env.SITE ?? "https://hansan-web.sjseo1221.workers.dev";
type Stats = { days: Record<string, Record<string, number>>; chatCostMonth: number };
async function loadStats(): Promise<Stats | null> {
  try {
    return (await (await fetch(`${site}/api/stats`, { signal: AbortSignal.timeout(15000) })).json()) as Stats;
  } catch {
    return null;
  }
}
const stats = await loadStats();
// 주의 모든 날짜가 조회 창(최근 14일) 안에 있어야 한다 — 밖이면 0 이 아니라 '확인 못 함'
const statsCover = Boolean(stats && days.every((d) => d in (stats.days ?? {})));
const visits = { visit: 0, detail: 0, chat: 0 };
for (const d of days) for (const k of Object.keys(visits) as (keyof typeof visits)[]) visits[k] += stats?.days?.[d]?.[k] ?? 0;

// 6) GitHub Actions 실행 시간(NFR-COST-04) — 공개 저장소는 표준 러너 무료. 기록만
let actionsMinutes: number | null = null;
if (process.env.GITHUB_TOKEN && process.env.GITHUB_REPOSITORY) {
  let mins = 0;
  let ok = true;
  for (let page = 1; page <= 10; page++) {
    const r = await fetch(`https://api.github.com/repos/${process.env.GITHUB_REPOSITORY}/actions/runs?created=${days[0]}..${days[6]}&per_page=100&page=${page}`, {
      headers: { authorization: `Bearer ${process.env.GITHUB_TOKEN}`, accept: "application/vnd.github+json" },
    });
    if (!r.ok) {
      ok = false; // 한 쪽이라도 못 읽으면 부분 합이 아니라 '확인 못 함'
      break;
    }
    const j = (await r.json()) as { workflow_runs: { run_started_at: string; updated_at: string }[] };
    for (const w of j.workflow_runs) mins += Math.max(0, (Date.parse(w.updated_at) - Date.parse(w.run_started_at)) / 60000);
    if (j.workflow_runs.length < 100) break;
  }
  actionsMinutes = ok ? Math.round(mins) : null;
}

const round4 = (x: number) => Math.round(x * 10000) / 10000;
const coverage = await readJson<Record<string, unknown>>("data/reports/coverage/latest.json", {});
const report = {
  week,
  days: [days[0], days[6]],
  accuracy: acc,
  types,
  recLogDays: logs.length,
  failures,
  usage: warnings,
  openai: { generationWeekUsd: round4(genWeek), generationMonthUsd: round4(genMonth), chatMonthUsd: stats ? round4(stats.chatCostMonth) : null, budgetUsd: llmCfg.budget.monthlyUsd },
  visits: statsCover ? visits : null,
  actionsMinutes,
  coverage: { places: coverage.places, sources: coverage.sources },
  // 이용 수·실행 시간을 모두 읽었을 때만 완결 — 아니면 다음 실행이 다시 만든다
  complete: statsCover && actionsMinutes !== null,
};

const label = (t: string) => TYPE_TEXT[t]?.label ?? t;
const lines = [
  `# 한산 주간 품질 리포트 ${week}`,
  "",
  `기간 ${days[0]} ~ ${days[6]} · 생성 ${today} · 원자료 \`${jsonPath}\``,
  "",
  "## 예측 적중률 (FR-OPS-03)",
  "",
  `'한산 가능성 높음' 추천 ${acc.recommendedHigh}건 중 서울 실측으로 확인할 수 있는 ${acc.evaluable}건에서, 방문 시간대(${thresholds.accuracy.hours[0]}~${thresholds.accuracy.hours[1]}시)에 주로 '${thresholds.accuracy.quietLevels.join("·")}'였던 곳은 ${acc.quiet}건 — **적중률 ${acc.rate === null ? "계산 불가" : `${acc.rate}%`}**. 실측 자료가 없어 뺀 건수 ${acc.excluded}건.`,
  "",
  `## 유형별 추천 수 (날짜 합, 기록 ${logs.length}일)`,
  "",
  ...(Object.keys(types).length ? Object.entries(types).map(([t, n]) => `- ${label(t)}: ${n}`) : ["- 기록 없음"]),
  "",
  "## 수집 실패 내역",
  "",
  ...(Object.keys(failures).length ? Object.entries(failures).sort((a, b) => b[1] - a[1]).map(([k, n]) => `- ${k}: ${n}`) : ["- 없음"]),
  "",
  "## 외부 서비스 사용량 (무료 한도 대비, 80% 이상 경고 — FR-OPS-08)",
  "",
  "| 서비스 | 기준 | 사용 | 한도 | 비율 | 경고 |",
  "|---|---|---|---|---|---|",
  ...warnings.map((w) => `| ${w.service} | ${w.per === "day" ? "가장 많은 날" : "이번 달 누적"} | ${w.used} | ${w.limit} | ${w.pct}% | ${w.warn ? "**경고**" : ""} |`),
  "",
  "사용량은 수집기 자체 카운터 기준이다(제공처 콘솔 집계와 다를 수 있다). 하루 한도는 주중 가장 많이 쓴 날, 월 한도는 그 주가 걸친 달 중 가장 많은 달의 누적.",
  "",
  `GitHub Actions 실행 시간: ${actionsMinutes === null ? "확인 못 함" : `약 ${actionsMinutes}분`} (생성일 UTC 기준·대기 포함 대략값) — 공개 저장소라 표준 러너는 무료.`,
  "",
  "## OpenAI 비용",
  "",
  `- 근거 문장·후기 판정: 이번 주 $${report.openai.generationWeekUsd}, 이번 달 누적 $${report.openai.generationMonthUsd} (생성 상한 $${llmCfg.generation.monthlyUsd})`,
  `- 대화: 이번 달 누적 ${report.openai.chatMonthUsd === null ? "확인 못 함" : `$${report.openai.chatMonthUsd}`} (차단선 $${llmCfg.budget.appCutoffUsd})`,
  `- 월 예산 $${llmCfg.budget.monthlyUsd}`,
  "",
  "## 이용 (FR-OPS-06, 개인 식별 정보 없음)",
  "",
  report.visits ? `- 화면 방문 ${visits.visit} · 상세 열람 ${visits.detail} · 대화 요청 ${visits.chat}` : "- 확인 못 함",
  "",
  "## 데이터 확보율 (최신 계산 기준)",
  "",
  `- 장소: ${JSON.stringify(coverage.places ?? {})}`,
  `- 출처: ${JSON.stringify(coverage.sources ?? {})}`,
  "",
];
await mkdir("docs/reports/weekly", { recursive: true });
await writeFile(mdPath, lines.join("\n"), "utf8");
// md 를 다 쓴 뒤 json 을 쓴다 — 중간에 죽으면 다음 실행이 다시 만든다
await writeJson(jsonPath, report);
console.log(JSON.stringify({ week, accuracy: acc, warn: warnings.filter((w) => w.warn).map((w) => w.service), visits: report.visits }));
