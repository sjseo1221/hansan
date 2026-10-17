// 근거 문장(FR-LLM-01·02·06·07)·후기 판정(FR-LLM-03~05)·장소 한 줄 소개 생성. compute-daily 다음에 돈다(그 뒤 compute-daily 를 한 번 더 돌려 캐시를 반영).
// OPENAI_API_KEY 가 없으면 아무것도 하지 않는다 — 화면은 정형 문장(FR-LLM-08)을 쓴다.
// 블로그 제목·요약은 판정 입력으로만 쓰고 저장하지 않는다(공개 저장소, 약관 재배포 범위 미확인)
import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { parse } from "yaml";
import { HOST } from "../collect/naver.js";
import { DailyUsage } from "../lib/usage.js";
import { readJson, writeJson } from "../lib/store.js";
import { kstParts } from "../lib/time.js";
import { factsFor, KNOWN_PATH, loadFactContext, REASONS_PATH, REVIEWS_PATH, type KnownCache, type RecItemLite, type ReasonCache, type ReviewCache } from "../llm/context.js";
import { isKnown, isReview, KNOWN_SCHEMA, REASON_SCHEMA, REVIEW_SCHEMA, validReason } from "../llm/facts.js";
import type { Place } from "../places/build.js";
import { addDays } from "../score/stats.js";
import { callJson, emptyUsage, LlmError, type Price } from "../shared/openai.js";

if (existsSync(".env")) process.loadEnvFile(".env");
const key = process.env.OPENAI_API_KEY;
const asOf = process.env.ASOF ?? kstParts(new Date()).date;
if (!key) {
  console.log(JSON.stringify({ skipped: "OPENAI_API_KEY 없음 — 정형 문장 사용(FR-LLM-08)" }));
  process.exit(0);
}
// 유료 호출이라 로컬에서는 LLM_RUN=1 일 때만 돈다(환경 변수에 키가 있어도 실수로 쓰지 않게). Actions 는 CI=true
if (!process.env.CI && process.env.LLM_RUN !== "1") {
  console.log(JSON.stringify({ skipped: "로컬 실행 — LLM_RUN=1 일 때만 호출" }));
  process.exit(0);
}

const cfg = parse(await readFile("config/llm.yaml", "utf8")) as {
  model: string;
  price: Price;
  reason: { maxSentences: number; maxChars: number };
  review: { minReviews: number; recentDays: number };
  generation: { reasoningEffort: string; maxCallsPerRun: number; monthlyUsd: number; reviewRefreshDays: number; reviewBlogCalls: number };
};
const apiKey: string = key; // 아래 함수 안에서도 정의된 값으로
// LLM_MODE: reviews(후기 판정·장소 소개) → (compute) → reasons(근거 문장). 후기 판정이 숨은 클래식 통과를 바꾸므로 근거 문장보다 먼저 돈다
const mode = process.env.LLM_MODE ?? "all";
const month = asOf.slice(0, 7);
const monthPath = `data/state/llm/usage-${month}.json`;
const monthUsage = await readJson(monthPath, emptyUsage());
const usage = emptyUsage();
const maxCalls = Number(process.env.LLM_MAX_CALLS ?? cfg.generation.maxCallsPerRun);
const budgetLeft = () => monthUsage.costUsd + usage.costUsd < cfg.generation.monthlyUsd && usage.calls < maxCalls;
// 시간 예산 — 이 시간이 지나면 새 호출을 시작하지 않고 지금까지의 결과를 저장해 끝낸다.
// 워크플로 제한(20분)에 걸려 프로세스가 죽으면 캐시가 저장되지 않아 매일 처음부터 다시 하게 된다(2026-10-13~17 compute-daily 취소 원인)
const deadline = Date.now() + Number(process.env.LLM_DEADLINE_MIN ?? 10) * 60_000;
const timeUp = () => Date.now() > deadline;
async function pool<T>(items: T[], n: number, fn: (x: T) => Promise<void>) {
  let i = 0;
  await Promise.all(Array.from({ length: n }, async () => {
    while (i < items.length) await fn(items[i++]);
  }));
}
const failures: Record<string, number> = {};
const fail = (e: unknown) => {
  const c = e instanceof LlmError ? e.code : "UNKNOWN";
  failures[c] = (failures[c] ?? 0) + 1;
};
const stats = { reasons: { needed: 0, reused: 0, generated: 0, invalid: 0, failed: 0, skippedBudget: 0 }, reviews: { needed: 0, reused: 0, fewPosts: 0, judged: 0, failed: 0, skipped: 0 }, known: { needed: 0, reused: 0, noOverview: 0, generated: 0, empty: 0, failed: 0, skippedBudget: 0 } };

const { places } = await readJson<{ places: Place[] }>("data/places/places.json", { places: [] });
const byId = new Map(places.map((p) => [p.placeId, p]));
const recs: Record<string, { items: RecItemLite[]; candidates?: { hidden_classic?: string[] } }> = {};
for (const f of (await readdir("data/recommendations")).filter((f) => f.endsWith(".json") && f.slice(0, 10) >= asOf).sort()) recs[f.slice(0, 10)] = await readJson(`data/recommendations/${f}`, { items: [] });

async function reasons() {
// 1) 근거 문장 — 캐시에 없는 사실만
const fc = await loadFactContext();
const cache = await readJson<ReasonCache>(REASONS_PATH, {});
const facts = factsFor(recs, byId, fc);
const queue = [...facts.values()].filter((x) => {
  stats.reasons.needed++;
  if (x.hash in cache) {
    stats.reasons.reused++;
    cache[x.hash].at = asOf; // 쓰인 날 갱신 — 오래 안 쓰인 것만 정리
    return false;
  }
  return true;
});
const seen = new Set<string>();
const work = queue.filter((x) => !seen.has(x.hash) && seen.add(x.hash));
await pool(work, 5, async (x) => {
  if (!budgetLeft() || timeUp()) {
    stats.reasons.skippedBudget++;
    return;
  }
  try {
    const out = await callJson(
      apiKey,
      {
        model: cfg.model,
        name: "reason",
        instructions: fc.prompt,
        input: x.facts,
        schema: REASON_SCHEMA,
        validate: (v): v is { reason: string } => typeof (v as { reason?: unknown })?.reason === "string",
        maxOutputTokens: 200,
        reasoningEffort: cfg.generation.reasoningEffort,
      },
      usage,
      cfg.price,
    );
    const ok = out && validReason(out.reason, x.facts, cfg.reason.maxChars, cfg.reason.maxSentences);
    cache[x.hash] = { r: ok ? out!.reason.trim() : null, at: asOf };
    if (ok) stats.reasons.generated++;
    else stats.reasons.invalid++;
  } catch (e) {
    // 네트워크·HTTP 오류는 캐시하지 않는다 — 다음 실행에 다시 시도
    stats.reasons.failed++;
    fail(e);
  }
});
// 30일 넘게 안 쓰인 캐시 정리
for (const [h, v] of Object.entries(cache)) if (v.at < addDays(asOf, -30)) delete cache[h];
await writeJson(REASONS_PATH, cache, 0);
}

async function reviewsRun() {
// 2) 후기 판정 — 숨은 클래식 후보와 인기 장소(화제 이유). 7일 안에 판정한 장소는 재사용
const reviews = await readJson<ReviewCache>(REVIEWS_PATH, {});
const targets = new Set<string>();
for (const r of Object.values(recs)) {
  for (const id of r.candidates?.hidden_classic ?? []) targets.add(id);
  for (const it of r.items) if ((it.popularity ?? 0) >= 70) targets.add(it.placeId);
}
const naverId = process.env.NAVER_CLIENT_ID;
const naverSecret = process.env.NAVER_CLIENT_SECRET;
const blogUsage = await DailyUsage.load("data", "naver_blog_llm", asOf, cfg.generation.reviewBlogCalls);
const reviewPrompt = await readFile("prompts/review.md", "utf8");
const strip = (s: string) => s.replace(/<[^>]+>/g, "").replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&#39;/g, "'");
const todo: string[] = [];
for (const id of [...targets].sort()) {
  stats.reviews.needed++;
  const prev = reviews[id];
  if (prev && prev.at >= addDays(asOf, -cfg.generation.reviewRefreshDays)) stats.reviews.reused++;
  else todo.push(id);
}
await pool(todo, 5, async (id) => {
  const p = byId.get(id);
  if (!p || !naverId || !naverSecret || !budgetLeft() || timeUp() || !blogUsage.tryConsume()) {
    stats.reviews.skipped++;
    return;
  }
  await blogUsage.save();
  try {
    const res = await fetch(`${HOST}/search/v1/blog?query=${encodeURIComponent(p.keyword)}&display=20&sort=date`, {
      headers: { "X-NCP-APIGW-API-KEY-ID": naverId, "X-NCP-APIGW-API-KEY": naverSecret },
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) throw new LlmError(`NAVER_${res.status}`);
    const j = (await res.json()) as { items?: { title: string; description: string; postdate: string }[] };
    // 최근 recentDays 안의 글만 — 지난 계절 글로 '요즘 화제'를 잘못 말하지 않게(2026-10-12 '여름철 수영장' 사례)
    const since = addDays(asOf, -cfg.review.recentDays).replaceAll("-", "");
    const posts = (j.items ?? []).filter((i) => i.postdate >= since).map((i) => ({ title: strip(i.title), summary: strip(i.description), date: i.postdate }));
    if (posts.length < cfg.review.minReviews) {
      // 후기 5건 미만이면 판단 보류 (FR-LLM-03)
      reviews[id] = { verdict: "undecided", reason: "최근 후기가 적어 판단을 보류했어요.", quietTime: "", buzz: "", n: posts.length, at: asOf };
      stats.reviews.fewPosts++;
      return;
    }
    const out = await callJson(
      apiKey,
      { model: cfg.model, name: "review", instructions: reviewPrompt, input: { place: p.name, posts }, schema: REVIEW_SCHEMA, validate: isReview, maxOutputTokens: 300, reasoningEffort: cfg.generation.reasoningEffort },
      usage,
      cfg.price,
    );
    if (!out) {
      stats.reviews.failed++;
      return;
    }
    reviews[id] = { ...out, n: posts.length, at: asOf };
    stats.reviews.judged++;
  } catch (e) {
    stats.reviews.failed++;
    fail(e);
  }
});
await writeJson(REVIEWS_PATH, reviews);
}

async function knownRun() {
// 3) 장소 한 줄 소개(2026-10-13 사용자 요청: 많이 찾는 이유) — 인기 장소(70 이상)만, 관광공사 소개 글이 바뀌었을 때만 다시 만든다
const cache = await readJson<KnownCache>(KNOWN_PATH, {});
const { overview } = await readJson<{ overview: Record<string, { text: string }> }>("data/sources/tour/overview.json", { overview: {} });
const prompt = await readFile("prompts/known.md", "utf8");
const targets = new Set<string>();
for (const r of Object.values(recs)) for (const it of r.items) if ((it.popularity ?? 0) >= 70) targets.add(it.placeId);
await pool([...targets].sort(), 5, async (id) => {
  stats.known.needed++;
  const text = overview[id]?.text ?? "";
  if (!text) {
    stats.known.noOverview++;
    return;
  }
  const h = createHash("sha256").update(prompt).update("\n").update(text).digest("hex").slice(0, 16);
  if (cache[id]?.h === h) {
    stats.known.reused++;
    return;
  }
  if (!budgetLeft() || timeUp()) {
    stats.known.skippedBudget++;
    return;
  }
  try {
    const out = await callJson(
      apiKey,
      { model: cfg.model, name: "known", instructions: prompt, input: { place: byId.get(id)?.name ?? "", overview: text }, schema: KNOWN_SCHEMA, validate: isKnown, maxOutputTokens: 120, reasoningEffort: cfg.generation.reasoningEffort },
      usage,
      cfg.price,
    );
    if (!out) {
      stats.known.failed++;
      return;
    }
    // 빈 문자열도 저장한다 — 같은 글로 다시 묻지 않게
    cache[id] = { known: out.known.trim(), h, at: asOf };
    if (out.known.trim()) stats.known.generated++;
    else stats.known.empty++;
  } catch (e) {
    stats.known.failed++;
    fail(e);
  }
});
await writeJson(KNOWN_PATH, cache);
}

// 어떤 오류가 나도 이미 청구된 사용량은 기록한다(FR-LLM-10). 이 단계 실패는 화면 발행을 막지 않는다(워크플로 continue-on-error)
try {
  if (mode !== "reasons") await reviewsRun();
  if (mode !== "reasons") await knownRun();
  if (mode !== "reviews") await reasons();
} catch (e) {
  fail(e);
}

// 4) 호출 수·비용 기록 (FR-LLM-10)
for (const k of ["calls", "inputTokens", "cachedTokens", "outputTokens", "costUsd"] as const) monthUsage[k] += usage[k];
await writeJson(monthPath, monthUsage);
const report = { asOf, model: cfg.model, run: { ...usage, costUsd: Math.round(usage.costUsd * 10000) / 10000 }, month: { ...monthUsage, costUsd: Math.round(monthUsage.costUsd * 10000) / 10000 }, ...stats, failures };
await writeJson(`data/reports/llm/${asOf}-${mode}.json`, report);
console.log(JSON.stringify(report));
