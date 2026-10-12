// 한산 화면 Worker — 정적 화면(web/dist), /data/*.json(public-data 브랜치 프록시), /api/chat(대화, FR-CHAT).
// 대화: LLM 은 사용자 말을 필터 조건(JSON)으로만 바꾼다. 장소·수치는 미리 계산된 피드에서 화면과 같은 코드로 고른다 → 지어낸 장소 없음(FR-CHAT-03).
// 대화 내용은 저장하지 않는다(FR-CHAT-06). 횟수·예산 카운터만 Durable Object 에 둔다. 원 IP 는 저장하지 않고 일별 비밀 값으로 HMAC 한 키만 쓴다
import { DurableObject } from "cloudflare:workers";
import { distanceKm, matches, relaxations, travelMinutes, TYPE_IDS, type FeedItem, type Filters, type TypeId } from "../../pipeline/src/shared/feed";
import { callJson, emptyUsage, LlmError } from "../../pipeline/src/shared/openai";
import CHAT_PROMPT from "../../prompts/chat.md";

interface Env {
  ASSETS: Fetcher;
  COUNTER: DurableObjectNamespace<Counter>;
  REPO: string;
  MODEL: string;
  PRICE_INPUT: string;
  PRICE_CACHED: string;
  PRICE_OUTPUT: string;
  PER_USER_DAILY: string;
  SERVICE_DAILY: string;
  CUTOFF_USD: string;
  MAX_INPUT_CHARS: string;
  MAX_CARDS: string;
  OPENAI_API_KEY?: string;
  CHAT_SALT?: string;
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" } });

async function data<T>(env: Env, path: string): Promise<T> {
  const res = await fetch(`https://raw.githubusercontent.com/${env.REPO}/refs/heads/public-data/${path}`, { cf: { cacheTtl: 300, cacheEverything: true } });
  if (!res.ok) throw new Error(`data ${res.status}`);
  return res.json() as Promise<T>;
}

const kstToday = () => new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 10);

// 횟수·예산 카운터 — 이용자 하루 N회(FR-CHAT-08), 서비스 하루 상한·월 누적 비용 차단선(FR-CHAT-09)
export class Counter extends DurableObject {
  async status(date: string, cutoff: number, serviceDaily: number) {
    const s = (await this.ctx.storage.get<number>(`s:${date}`)) ?? 0;
    const cost = (await this.ctx.storage.get<number>(`c:${date.slice(0, 7)}`)) ?? 0;
    return { service: s, cost, open: s < serviceDaily && cost < cutoff };
  }
  async take(date: string, user: string, perUser: number, serviceDaily: number, cutoff: number) {
    await this.cleanup(date);
    const st = await this.status(date, cutoff, serviceDaily);
    if (!st.open) return { ok: false, reason: "closed" as const };
    const uk = `u:${date}:${user}`;
    const u = (await this.ctx.storage.get<number>(uk)) ?? 0;
    if (u >= perUser) return { ok: false, reason: "user_limit" as const };
    await this.ctx.storage.put({ [uk]: u + 1, [`s:${date}`]: st.service + 1 });
    return { ok: true as const };
  }
  async addCost(date: string, usd: number) {
    const k = `c:${date.slice(0, 7)}`;
    await this.ctx.storage.put(k, ((await this.ctx.storage.get<number>(k)) ?? 0) + usd);
  }
  // 하루 지난 이용자 키는 지운다(24시간 뒤 삭제 — 착수 계획 7.1)
  private async cleanup(date: string) {
    if ((await this.ctx.storage.get<string>("cleaned")) === date) return;
    const old = [...(await this.ctx.storage.list({ prefix: "u:" })).keys()].filter((k) => !k.startsWith(`u:${date}:`));
    for (let i = 0; i < old.length; i += 128) await this.ctx.storage.delete(old.slice(i, i + 128));
    await this.ctx.storage.put("cleaned", date);
  }
}

async function userKey(env: Env, ip: string, date: string) {
  const k = await crypto.subtle.importKey("raw", new TextEncoder().encode(`${env.CHAT_SALT}|${date}`), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(ip));
  return [...new Uint8Array(sig).slice(0, 16)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

interface Ask {
  offTopic: boolean;
  date: string;
  origin: string | null;
  minutes: number | null;
  companion: string | null;
  indoor: "indoor" | "outdoor" | null;
  types: string[];
  quieter: boolean;
}

const ASK_SCHEMA = {
  type: "object",
  properties: {
    offTopic: { type: "boolean" },
    date: { type: "string" },
    origin: { type: ["string", "null"] },
    minutes: { type: ["integer", "null"], enum: [30, 60, 120, null] },
    companion: { type: ["string", "null"] },
    indoor: { type: ["string", "null"], enum: ["indoor", "outdoor", null] },
    types: { type: "array", items: { type: "string", enum: [...TYPE_IDS] } },
    quieter: { type: "boolean" },
  },
  required: ["offTopic", "date", "origin", "minutes", "companion", "indoor", "types", "quieter"],
  additionalProperties: false,
};

const isAsk = (x: unknown): x is Ask => {
  const a = x as Ask;
  return Boolean(a) && typeof a.offTopic === "boolean" && typeof a.date === "string" && Array.isArray(a.types) && typeof a.quieter === "boolean";
};

const WD = "일월화수목금토";
const dateLabel = (d: string) => `${Number(d.slice(5, 7))}월 ${Number(d.slice(8, 10))}일(${WD[new Date(`${d}T00:00:00Z`).getUTCDay()]})`;
const LH_ORDER = { high: 0, medium: 1, low: 2 } as const;

async function chat(request: Request, env: Env): Promise<Response> {
  const today = kstToday();
  const cutoff = Number(env.CUTOFF_USD);
  const counter = env.COUNTER.get(env.COUNTER.idFromName("global"));
  if (!env.OPENAI_API_KEY || !env.CHAT_SALT) return json({ ok: false, closed: true, text: "대화 기능은 아직 준비 중이에요. 피드에서 조건을 골라 주세요." });

  // 본문 크기 제한 — 메시지 200자 + 조건 몇 개면 충분하다(큰 입력으로 비용을 키우지 못하게)
  const raw = await request.text();
  if (raw.length > 2000) return json({ ok: false, text: "요청이 너무 길어요." }, 413);
  let body: { message?: unknown; current?: Partial<Filters> & { types?: unknown } };
  try {
    body = JSON.parse(raw);
  } catch {
    return json({ ok: false, text: "요청 형식이 올바르지 않아요." }, 400);
  }
  const message = typeof body.message === "string" ? body.message.trim() : "";
  if (!message) return json({ ok: false, text: "찾고 싶은 나들이 조건을 말해 주세요." }, 400);
  if (message.length > Number(env.MAX_INPUT_CHARS)) return json({ ok: false, text: `${env.MAX_INPUT_CHARS}자 이내로 말해 주세요.` }, 400);

  // 자료를 먼저 읽는다 — 자료 문제로 실패하면 이용 횟수를 쓰지 않게
  let meta: { dates: string[] }, config: { companions: { id: string; label: string; suitable: string[] }[]; travel: { detourFactor: number; speedKmh: number }; types: { id: string; label: string }[] }, regions: { sigungu: { code: string; name: string; provinceCd: string; lat: number; lng: number }[]; provinces: { code: string; name: string }[] };
  try {
    [meta, config, regions] = await Promise.all([data<typeof meta>(env, "meta.json"), data<typeof config>(env, "config.json"), data<typeof regions>(env, "regions.json")]);
  } catch {
    return json({ ok: false, text: "추천 자료를 불러오지 못했어요. 피드에서 조건을 골라 주세요." }, 503);
  }
  const dates = meta.dates.filter((d) => d >= today);
  if (!dates.length) return json({ ok: false, text: "지금 추천할 날짜 자료가 없어요." }, 503);

  // IPv6 는 /64 로 묶는다 — 같은 회선에서 주소만 바꿔 이용자 제한을 피하지 못하게
  const ipRaw = request.headers.get("CF-Connecting-IP") ?? "unknown";
  const ip = ipRaw.includes(":") ? ipRaw.split(":").slice(0, 4).join(":") : ipRaw;
  const t = await counter.take(today, await userKey(env, ip, today), Number(env.PER_USER_DAILY), Number(env.SERVICE_DAILY), cutoff);
  if (!t.ok)
    return json({
      ok: false,
      closed: t.reason === "closed",
      text: t.reason === "user_limit" ? `대화는 하루 ${env.PER_USER_DAILY}번까지 쓸 수 있어요. 내일 다시 이용하거나 피드에서 조건을 골라 주세요.` : "오늘은 대화를 더 받을 수 없어요. 피드에서 조건을 골라 주세요.",
    });

  const provName = (c: string) => regions.provinces.find((p) => p.code === c)?.name ?? "";
  const regionName = (s: { name: string; provinceCd: string }) => `${provName(s.provinceCd)} ${s.name}`;
  // 화면이 보낸 현재 조건도 선택지에 있는 값만 받는다(모델 입력에 임의 문자열이 들어가지 않게)
  const c0 = body.current ?? {};
  const curOrigin = regions.sigungu.find((s) => s.code === c0.origin);
  const curTypes = Array.isArray(c0.types) ? c0.types.filter((x): x is TypeId => typeof x === "string" && (TYPE_IDS as readonly string[]).includes(x)) : [];
  const cur = {
    date: dates.includes(String(c0.date)) ? String(c0.date) : dates[0],
    minutes: [30, 60, 120].includes(Number(c0.minutes)) ? Number(c0.minutes) : null,
    companion: config.companions.some((c) => c.id === c0.companion) ? (c0.companion as string) : null,
    indoor: c0.indoor === "indoor" || c0.indoor === "outdoor" ? c0.indoor : null,
  };

  const usage = emptyUsage();
  let ask: Ask | null;
  try {
    ask = await callJson(
      env.OPENAI_API_KEY,
      {
        model: env.MODEL,
        name: "filters",
        instructions: CHAT_PROMPT,
        input: {
          message,
          current: { date: cur.date, origin: curOrigin ? regionName(curOrigin) : null, minutes: cur.minutes, companion: cur.companion, indoor: cur.indoor, types: curTypes },
          today,
          dates,
          regions: regions.sigungu.map(regionName),
          companions: config.companions.map((c) => `${c.id}=${c.label}`),
          types: config.types.map((x) => `${x.id}=${x.label}`),
        },
        schema: ASK_SCHEMA,
        validate: isAsk,
        maxOutputTokens: 300,
        timeoutMs: 8000,
      },
      usage,
      { input: Number(env.PRICE_INPUT), cachedInput: Number(env.PRICE_CACHED), output: Number(env.PRICE_OUTPUT) },
    );
  } catch (e) {
    return json({ ok: false, text: "답을 만들지 못했어요. 지금 조건의 피드를 보여 드릴게요.", error: e instanceof LlmError ? e.code : "ERROR" }, 502);
  } finally {
    await counter.addCost(today, usage.costUsd);
  }
  if (!ask) return json({ ok: false, text: "말씀을 이해하지 못했어요. 날짜·지역·누구와 같은 조건으로 다시 말해 주세요." });
  if (ask.offTopic) return json({ ok: true, offTopic: true, text: "한산은 덜 붐비는 나들이 장소 추천만 도와드려요. 예: '이번 토요일 아이랑 갈 만한 실내 장소'" });

  // 모델 출력은 그대로 믿지 않는다 — 선택지에 있는 값만 받는다
  const origin = regions.sigungu.find((s) => regionName(s) === ask!.origin || s.name === ask!.origin) ?? curOrigin ?? null;
  const f: Filters = {
    date: dates.includes(ask.date) ? ask.date : cur.date,
    origin: origin?.code ?? null,
    minutes: origin && [30, 60, 120].includes(ask.minutes ?? -1) ? ask.minutes : null,
    companion: config.companions.some((c) => c.id === ask!.companion) ? ask.companion : null,
    indoor: ask.indoor === "indoor" || ask.indoor === "outdoor" ? ask.indoor : null,
  };
  // 선호 유형은 새로 말하지 않으면 앞선 조건을 이어받는다(FR-CHAT-05)
  const asked = ask.types.filter((x): x is TypeId => (TYPE_IDS as readonly string[]).includes(x));
  const types = asked.length ? asked : curTypes;
  const feed = await data<{ items: FeedItem[] }>(env, `feed/${f.date}.json`);
  const fcfg = { travel: config.travel, companions: config.companions, maxPerType: 10, topN: 3 };
  let items = feed.items.filter((x) => matches(x, f, origin, fcfg) && (!types.length || x.types.some((t) => types.includes(t))));
  if (ask.quieter && items.some((x) => x.lh === "high")) items = items.filter((x) => x.lh === "high");
  items.sort((a, b) => LH_ORDER[a.lh] - LH_ORDER[b.lh] || (b.pop ?? -1) - (a.pop ?? -1) || (a.id < b.id ? -1 : 1));
  const cards = items.slice(0, Number(env.MAX_CARDS)).map((x) => ({ id: x.id, name: x.name, area: x.area, lh: x.lh, rep: x.rep, minutes: origin ? travelMinutes(distanceKm(origin, x), config.travel) : null }));

  const cond = [dateLabel(f.date), origin ? `${regionName(origin)}에서${f.minutes ? ` 약 ${f.minutes}분 이내` : ""}` : "", config.companions.find((c) => c.id === f.companion)?.label ?? "", f.indoor === "indoor" ? "실내" : f.indoor === "outdoor" ? "실외" : "", types.map((x) => config.types.find((y) => y.id === x)?.label).filter(Boolean).join("·")]
    .filter(Boolean)
    .join(", ");
  if (!cards.length) {
    // 없으면 없다고 말하고 가장 가까운 조건을 제안(FR-CHAT-07)
    const r = relaxations(feed.items, f, origin, fcfg)[0];
    const label = { minutes: "이동 시간 제한을 풀면", companion: "'누구와' 조건을 풀면", indoor: "실내·실외 조건을 풀면" };
    const withoutTypes = types.length ? feed.items.filter((x) => matches(x, f, origin, fcfg)).length : 0;
    const hint = withoutTypes ? ` 선호 유형을 풀면 ${withoutTypes}곳이 있어요.` : r ? ` ${label[r.key]} ${r.count}곳이 있어요.` : " 다른 날짜로 바꿔 보세요.";
    return json({ ok: true, filters: { ...f, types }, cards, text: `${cond} 조건에 맞는 장소가 없어요.${hint}` });
  }
  return json({ ok: true, filters: { ...f, types }, cards, text: `${cond} 조건으로 한산할 가능성이 높은 순서대로 ${cards.length}곳을 골랐어요.` });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/api/chat/status") {
      if (!env.OPENAI_API_KEY || !env.CHAT_SALT) return json({ open: false });
      // 화면을 열 때마다 묻는 요청이라 30초 캐시 — 카운터(Durable Object) 호출을 아낀다
      const cache = caches.default;
      const hit = await cache.match(request);
      if (hit) return hit;
      const st = await env.COUNTER.get(env.COUNTER.idFromName("global")).status(kstToday(), Number(env.CUTOFF_USD), Number(env.SERVICE_DAILY));
      const res = new Response(JSON.stringify({ open: st.open }), { headers: { "content-type": "application/json; charset=utf-8", "cache-control": "public, max-age=30" } });
      await cache.put(request, res.clone());
      return res;
    }
    if (url.pathname === "/api/chat") {
      if (request.method !== "POST") return json({ ok: false }, 405);
      return chat(request, env);
    }
    if (url.pathname.startsWith("/data/")) {
      const path = url.pathname.slice("/data/".length);
      // 정해진 모양의 JSON 경로만 — 다른 파일·상위 경로 접근 차단
      if (!/^[A-Za-z0-9_\-/]+\.json$/.test(path) || path.includes("..") || path.includes("//")) return new Response("Not found", { status: 404 });
      const res = await fetch(`https://raw.githubusercontent.com/${env.REPO}/refs/heads/public-data/${path}`, { cf: { cacheTtl: 300, cacheEverything: true } });
      if (!res.ok) return new Response(res.status === 404 ? "Not found" : "Upstream error", { status: res.status === 404 ? 404 : 502 });
      return new Response(res.body, { headers: { "content-type": "application/json; charset=utf-8", "cache-control": "public, max-age=300", "x-content-type-options": "nosniff" } });
    }
    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;
