// 피드 화면 — 필터를 주소(URL)에 반영하고(FR-FLT-05), 같은 주소면 같은 결과를 보여 준다
import { distanceKm, groupFeed, matches, relaxations, ruleReason, travelMinutes, TYPE_IDS, type FeedItem, type Filters } from "../../../pipeline/src/shared/feed";
import { addDays, config, dateLabel, esc, getJson, LH_TEXT, meta, todayKst, weekday, type Config } from "./common";

interface Region {
  code: string;
  provinceCd: string;
  name: string;
  lat: number;
  lng: number;
}

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

// 기본 날짜: 가장 가까운 토요일(FR-FEED-01). 오늘이 일요일이면 이번 주말의 남은 날인 오늘
export function defaultDate(today: string, dates: string[]): string {
  const w = weekday(today);
  const sat = w === 0 ? today : addDays(today, (6 - w + 7) % 7);
  return dates.includes(sat) ? sat : (dates.find((d) => d >= today) ?? dates[0]);
}

// 주소의 값은 화면 선택지에 있는 것만 받는다 — 나머지는 조건 없음으로 본다
function readFilters(dates: string[], ok: { origins: Set<string>; minutes: number[]; companions: Set<string> }): Filters {
  const q = new URLSearchParams(location.search);
  const today = todayKst();
  const date = q.get("date") ?? "";
  const minutes = q.get("minutes");
  const indoor = q.get("indoor");
  return {
    date: dates.includes(date) && date >= today ? date : defaultDate(today, dates.filter((d) => d >= today)),
    origin: ok.origins.has(q.get("origin") ?? "") ? q.get("origin") : null,
    minutes: minutes && ok.minutes.includes(Number(minutes)) ? Number(minutes) : null,
    companion: ok.companions.has(q.get("companion") ?? "") ? q.get("companion") : null,
    indoor: indoor === "indoor" || indoor === "outdoor" ? indoor : null,
  };
}

function writeFilters(f: Filters) {
  const q = new URLSearchParams();
  q.set("date", f.date);
  if (f.origin) q.set("origin", f.origin);
  if (f.origin && f.minutes !== null) q.set("minutes", String(f.minutes));
  if (f.companion) q.set("companion", f.companion);
  if (f.indoor) q.set("indoor", f.indoor);
  history.replaceState(null, "", `?${q}`);
}

// basis: 카드마다 보이는 자료 기준 일시(검수 4)
function card(it: FeedItem, f: Filters, cfg: Config, origin: Region | null, basis: string): string {
  const type = cfg.types.find((t) => t.id === it.rep)!;
  const lh = LH_TEXT[it.lh];
  const mins = origin ? travelMinutes(distanceKm(origin, it), cfg.travel) : null;
  const slot =
    it.rep === "time_slot" && it.slot
      ? `<div>추천 시간대 <strong>${it.slot.start}~${it.slot.end}</strong> ${
          it.label === "추정" ? `<details><summary class="badge">추정</summary>서울 실시간 인구 자료가 없는 곳이라, 비슷한 장소와 지역 유동인구로 어림한 시간대예요.</details>` : `<span class="badge">실측</span>`
        }</div>`
      : "";
  return `<li class="card">
    <h3><a href="/place/?id=${encodeURIComponent(it.id)}&date=${f.date}">${esc(it.name)}</a></h3>
    <p class="where">${esc(it.area)}${mins !== null ? ` · 약 ${mins < 60 ? `${mins}분` : `${Math.floor(mins / 60)}시간 ${mins % 60}분`}` : ""}</p>
    <div><span class="badge">${esc(type.label)}</span>${
      it.beta ? ` <details><summary class="badge">베타</summary>판정 기준을 아직 검증하고 있는 유형이에요. 결과가 덜 정확할 수 있어요.</details>` : ""
    } <span class="lh-${it.lh}"><span aria-hidden="true">${lh.mark}</span> ${lh.text}</span></div>
    ${slot}
    <p>${esc(it.reason ?? ruleReason(it, it.rep))}${it.prov ? " <small>(평소 자료가 아직 적어 임시로 판단했어요)</small>" : ""}</p>
    <p class="basis">${esc(basis)}</p>
  </li>`;
}

export async function initFeed() {
  const feedEl = $("feed");
  try {
    const [m, cfg, regions] = await Promise.all([meta(), config(), getJson<{ provinces: { code: string; name: string }[]; sigungu: Region[] }>("regions.json")]);
    const today = todayKst();
    const dates = m.dates.filter((d) => d >= today && d <= addDays(today, 13));
    if (!dates.length) {
      feedEl.innerHTML = "<p>표시할 날짜의 추천이 아직 없습니다. 자료가 갱신되면 다시 보여 드릴게요.</p>";
      return;
    }
    // 예측 자료 기준 일시 — '10월 12일 12:03 기준'
    const fc = m.updated.forecast;
    const basis = fc ? `혼잡 예측 ${Number(fc.slice(5, 7))}월 ${Number(fc.slice(8, 10))}일 ${fc.slice(11, 16)} 기준` : "혼잡 예측 기준 일시 모름";
    let f = readFilters(dates, {
      origins: new Set(regions.sigungu.map((s) => s.code)),
      minutes: cfg.travel.options.filter((x): x is number => x !== null),
      companions: new Set(cfg.companions.map((c) => c.id)),
    });
    // 주소에 조건이 있으면 펼쳐서 보여 준다
    if (f.origin || f.companion || f.indoor) ($("more") as HTMLDetailsElement).open = true;

    // 필터 선택지 채우기
    const dateSel = $<HTMLSelectElement>("date");
    dateSel.innerHTML = dates.map((d) => `<option value="${d}">${dateLabel(d)}</option>`).join("");
    const wk = defaultDate(today, dates);
    const weekendDays = [wk, addDays(wk, 1)].filter((d) => dates.includes(d) && [0, 6].includes(weekday(d)));
    const weekendEl = $("weekend");
    weekendEl.innerHTML = weekendDays.map((d) => `<button type="button" data-date="${d}" aria-pressed="false">${dateLabel(d)}</button>`).join("");
    const originSel = $<HTMLSelectElement>("origin");
    originSel.innerHTML += regions.provinces
      .map((p) => `<optgroup label="${esc(p.name)}">${regions.sigungu.filter((s) => s.provinceCd === p.code).map((s) => `<option value="${s.code}">${esc(s.name)}</option>`).join("")}</optgroup>`)
      .join("");
    $<HTMLSelectElement>("companion").innerHTML += cfg.companions.map((c) => `<option value="${c.id}">${esc(c.label)}</option>`).join("");
    const minutesSel = $<HTMLSelectElement>("minutes");
    const form = $<HTMLFormElement>("filters");

    const syncForm = () => {
      dateSel.value = f.date;
      originSel.value = f.origin ?? "";
      minutesSel.disabled = !f.origin;
      minutesSel.value = f.minutes === null ? "" : String(f.minutes);
      $<HTMLSelectElement>("companion").value = f.companion ?? "";
      (form.querySelector(`input[name=indoor][value="${f.indoor ?? ""}"]`) as HTMLInputElement).checked = true;
      for (const b of weekendEl.querySelectorAll("button")) b.setAttribute("aria-pressed", String(b.dataset.date === f.date));
      // 접힌 조건 요약 — 무엇이 걸려 있는지 펼치지 않아도 보이게
      const on = [f.origin && regions.sigungu.find((s) => s.code === f.origin)?.name, f.companion && cfg.companions.find((c) => c.id === f.companion)?.label, f.indoor && (f.indoor === "indoor" ? "실내" : "실외")].filter(Boolean);
      $("more-summary").textContent = on.length ? `(${on.join(", ")})` : "";
    };

    // 마지막 요청만 그린다(빠르게 바꿀 때 늦게 온 이전 응답이 덮어쓰지 않게). 실패하면 이전 결과를 지우고 안내한다
    let seq = 0;
    const render = async () => {
      const t0 = performance.now();
      const my = ++seq;
      writeFilters(f);
      syncForm();
      let feed: { items: FeedItem[] };
      try {
        feed = await getJson<{ items: FeedItem[] }>(`feed/${f.date}.json`);
      } catch {
        if (my !== seq) return;
        $("heading").textContent = `${dateLabel(f.date)}, 덜 붐빌 나들이 장소`;
        feedEl.innerHTML = "<p>이 날짜의 추천을 불러오지 못했습니다. 잠시 뒤 다시 골라 주세요.</p>";
        $("count").textContent = "추천을 불러오지 못했습니다.";
        return;
      }
      if (my !== seq) return;
      $("heading").textContent = `${dateLabel(f.date)}, 덜 붐빌 나들이 장소`;
      const origin = f.origin ? (regions.sigungu.find((s) => s.code === f.origin) ?? null) : null;
      const fcfg = { travel: cfg.travel, companions: cfg.companions, maxPerType: cfg.maxPerType, topN: cfg.topN };
      const items = feed.items.filter((x) => matches(x, f, origin, fcfg));
      const groups = groupFeed(items, fcfg);
      feedEl.innerHTML = TYPE_IDS.map((t) => {
        const type = cfg.types.find((x) => x.id === t)!;
        const list = groups[t];
        return `<section class="type" aria-labelledby="h-${t}">
          <h2 id="h-${t}">${esc(type.label)}</h2>
          ${t === "early_hotspot" ? `<details><summary class="badge">베타</summary>판정 기준을 아직 검증하고 있는 유형이에요. 결과가 덜 정확할 수 있어요.</details>` : ""}
          <p class="type-desc">${esc(type.desc)}</p>
          ${list.length ? `<ul class="cards">${list.map((it) => card(it, f, cfg, origin, basis)).join("")}</ul>` : `<p>${dateLabel(f.date)}에는 해당 장소가 없습니다.</p>`}
        </section>`;
      }).join("");
      // 낭독기에는 결과 수 한 줄만 알린다
      const shown = TYPE_IDS.reduce((n, t) => n + groups[t].length, 0);
      $("count").textContent = `${dateLabel(f.date)} 추천 ${shown}곳을 보여 드려요.`;
      // 필터 적용 시간 기록(NFR-PERF-02 점검용) — 자료를 받는 시간까지 포함한 값
      feedEl.dataset.renderMs = String(Math.round(performance.now() - t0));
      // 조건에 맞는 곳이 없으면 완화 제안 (FR-FLT-06)
      const relaxEl = $("relax");
      relaxEl.innerHTML = "";
      if (!items.length) {
        const label = { minutes: "이동 시간 제한을 풀면", companion: "'누구와' 조건을 풀면", indoor: "실내·실외 조건을 풀면" };
        const r = relaxations(feed.items, f, origin, fcfg);
        relaxEl.innerHTML = r.length
          ? `<div class="relax notice"><p>조건에 맞는 장소가 없어요. 이렇게 바꿔 보세요.</p>${r.map((x) => `<button type="button" data-relax="${x.key}">${label[x.key]} ${x.count}곳</button>`).join("")}</div>`
          : `<p class="notice">조건에 맞는 장소가 없어요. 다른 날짜를 골라 보세요.</p>`;
      }
    };

    form.addEventListener("change", () => {
      const fd = new FormData(form);
      const origin = String(fd.get("origin") ?? "") || null;
      f = {
        date: String(fd.get("date") ?? f.date),
        origin,
        minutes: origin && fd.get("minutes") ? Number(fd.get("minutes")) : null,
        companion: String(fd.get("companion") ?? "") || null,
        indoor: (String(fd.get("indoor") ?? "") || null) as Filters["indoor"],
      };
      render();
    });
    weekendEl.addEventListener("click", (e) => {
      const d = (e.target as HTMLElement).closest("button")?.dataset.date;
      if (d) {
        f = { ...f, date: d };
        render();
      }
    });
    $("relax").addEventListener("click", (e) => {
      const k = (e.target as HTMLElement).closest("button")?.dataset.relax;
      if (k === "minutes") f = { ...f, minutes: null };
      if (k === "companion") f = { ...f, companion: null };
      if (k === "indoor") f = { ...f, indoor: null };
      if (k) render();
    });
    await render();
  } catch {
    feedEl.innerHTML = "<p>추천을 불러오지 못했습니다. 잠시 뒤 다시 열어 주세요.</p>";
  }
}
