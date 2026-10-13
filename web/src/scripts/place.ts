// 장소 상세 — 14일 혼잡 예측과 평소 비교(FR-DTL-02), 시간대 패턴(03), 유형·근거(04), 근처 대안(05), 지도 앱 링크(06), 운영 확인 안내(07)
import { ruleReason, type TypeId } from "../../../pipeline/src/shared/feed";
import { config, dateLabel, esc, getJson, LH_TEXT, meta, todayKst, weekday } from "./common";

interface Day {
  d: string;
  f: number | null;
  u: number | null;
  ub?: "history" | "forecast_window";
  uw?: number; // 평소 혼잡에 쓴 주 수
  lh: "high" | "medium" | "low" | null;
  rep: TypeId | null;
  types: TypeId[];
  slot?: { start: string; end: string; quietToPeak: number };
  closed?: boolean;
  cr?: string;
  caution?: boolean;
  prov?: boolean;
  fs?: boolean;
  reason?: string; // 대표 유형의 근거 문장(LLM)
}
interface Place {
  id: string;
  name: string;
  addr: string;
  area: string;
  dong?: string; // 경기 장소의 소속 행정동
  cat: string;
  indoor: "indoor" | "outdoor" | "mixed";
  op: { rest: string; hours: string } | null;
  lat: number;
  lng: number;
  pop: number | null;
  popx?: { search: number; blog: number | null; nav: number | null; searchBasis?: "week" | "month" };
  nav?: { rank: number; ym: string }; // 티맵 내비 기반 시·군·구 중심 관광지 순위
  trend: number | null;
  lt: number | null;
  pat?: { basis: string; label: "실측" | "추정"; wd: (number | null)[]; hd: (number | null)[] };
  days: Day[];
  known?: string; // 무엇으로 알려진 곳인지(관광공사 소개 글 요약)
  review?: { verdict: "worth_visiting" | "not_recommended" | "undecided"; reason: string; quietTime: string; buzz: string };
  alt: Record<string, [string, string, number][]>;
}

const INDOOR = { indoor: "실내", outdoor: "실외", mixed: "실내·실외" };

// 평소와 비교 — 숫자 차이를 쉬운 말로
function compare(f: number | null, u: number | null): string {
  if (f === null) return "예측 없음";
  if (u === null) return "평소 자료 쌓는 중";
  const d = f - u;
  if (d <= -10) return "평소보다 한산";
  if (d >= 10) return "평소보다 붐빔";
  return "평소와 비슷";
}

const pctTop = (pct: number) => `상위 ${Math.max(1, Math.round(100 - pct))}%`;
const ymdKo = (iso: string | null | undefined) => (iso ? `${Number(iso.slice(5, 7))}월 ${Number(iso.slice(8, 10))}일 ${iso.slice(11, 16)}` : "알 수 없음");

// 인기도를 끌어올린 신호 — 상위 10% 안에 드는 신호만, 없으면 가장 높은 신호 하나
function popSignals(p: Place): string {
  if (!p.popx) return "검색 자료를 아직 받지 못했어요.";
  const s: [number, string][] = [[p.popx.search, `네이버 검색 ${pctTop(p.popx.search)}`]];
  if (p.popx.blog !== null) s.push([p.popx.blog, `블로그 글 수 ${pctTop(p.popx.blog)}`]);
  if (p.popx.nav !== null && p.nav) s.push([p.popx.nav, `티맵 내비 목적지 ${esc(p.area)} ${p.nav.rank}위`]);
  s.sort((a, b) => b[0] - a[0]);
  const strong = s.filter(([v]) => v >= 90);
  return (strong.length ? strong : s.slice(0, 1)).map(([, t]) => t).join(" · ");
}

// 근거와 출처(2026-10-12 사용자 요청: 혼잡 예측 근거·인기 상위 % 출처를 상세히) — 숫자마다 어디서 왔고 어떻게 계산했는지
function sourcesHtml(p: Place, day: Day, m: Awaited<ReturnType<typeof meta>>, cfg: Awaited<ReturnType<typeof config>>): string {
  const w = cfg.weights;
  const items: string[] = [];
  items.push(`<li><strong>혼잡 예측(0~100)</strong>: 한국관광공사 '관광지 집중률 방문자 추이 예측'(공공데이터포털). KT 이동통신 데이터를 바탕으로 2018년부터의 방문 패턴을 기계학습해 앞으로 30일을 예측한 값이에요. <strong>이 관광지가 가장 붐비던 때를 100으로 둔 상대 값</strong>이라 다른 장소와 숫자를 바로 비교할 수는 없어요. KT 가입 휴대폰 기준이라 실제 방문자 수와 다를 수 있어요. 자료 기준 ${ymdKo(m.updated.forecast)}.</li>`);
  items.push(
    day.u === null
      ? `<li><strong>평소 혼잡</strong>: 같은 요일의 최근 8주 혼잡 예측 평균인데, 아직 자료를 쌓는 중이라 비워 두었어요.</li>`
      : `<li><strong>평소 혼잡</strong>: 같은 요일의 지난 혼잡 예측을 평균했어요(공휴일 제외) — 지금은 ${day.uw ?? 0}주치${(day.uw ?? 0) < 8 ? "로 계산해 임시 값이에요(8주가 차면 확정)" : ""}.</li>`,
  );
  if (p.pop !== null && p.popx) {
    const parts = [`네이버 검색어 트렌드(${p.popx.searchBasis === "month" ? "최근 완결 월" : "최근 4주"} 검색 관심도, 비중 ${Math.round((w?.searchWeight ?? 0) * 100)}%, 이 장소 ${pctTop(p.popx.search)})`];
    if (p.popx.blog !== null) parts.push(`네이버 블로그 글 수(비중 ${Math.round((w?.blogWeight ?? 0) * 100)}%, ${pctTop(p.popx.blog)})`);
    if (p.popx.nav !== null) parts.push(`한국관광공사 기초지자체 중심 관광지 순위 — 티맵 내비게이션 목적지 검색·이동 기준(비중 ${Math.round((w?.navWeight ?? 0) * 100)}%, ${p.nav ? `${esc(p.area)} ${p.nav.rank}위` : "시·군·구 상위 100곳 밖"})`);
    items.push(`<li><strong>인기도 ${pctTop(p.pop)}</strong>: 인기도를 매긴 ${m.popN ?? "?"}곳 중 순위예요. ${parts.join(", ")}를 각각 백분위로 바꿔 가중 평균했어요. 검색 자료 기준 ${ymdKo(m.updated.search)}.</li>`);
  } else items.push(`<li><strong>인기도</strong>: 네이버 검색 자료를 아직 받지 못해 비워 두었어요(장소마다 주 1회 받아요).</li>`);
  if (p.trend !== null) items.push(`<li><strong>요즘 관심 변화</strong>: 네이버 검색어 트렌드 최근 4주 평균을 그 전 8주와 비교했어요(${Math.round(p.trend * 100)}%).</li>`);
  if (p.lt !== null) items.push(`<li><strong>장기 관심 변화</strong>: 네이버 검색어 트렌드 최근 12개월 합을 3년 전 같은 기간과 비교했어요(${Math.round(p.lt * 100)}%).</li>`);
  if (p.pat) {
    const src =
      p.pat.basis === "measured"
        ? `서울시 실시간 도시데이터(서울 열린데이터광장)를 매시간 모은 최근 8주 시간별 인구`
        : p.pat.basis === "gg_blend" || p.pat.basis === "gg_only"
          ? `경기도 유동인구(경기데이터드림, 2026년 1~3월${p.dong ? `, ${esc(p.dong)}` : ""} 행정동)${p.pat.basis === "gg_blend" ? "와 서울 실측 장소의 같은 분류 평균을 반씩" : ""}`
          : p.pat.basis === "category"
            ? `서울 실측 장소 중 같은 분류(${esc(cfg.categories.find((c) => c.id === p.cat)?.label ?? p.cat)}) 평균`
            : `서울 실측 장소 전체 평균`;
    items.push(`<li><strong>시간대별 붐빔(${p.pat.label})</strong>: 바탕 자료 — ${src}. 가장 붐비는 시간을 1로 둔 상대 모양이에요.</li>`);
  }
  if (p.known) items.push(`<li><strong>어떤 곳</strong>: 한국관광공사 관광정보(TourAPI)의 장소 소개 글을 AI(OpenAI)가 한 줄로 줄였어요. 소개 글에 없는 내용과 숫자는 쓰지 않게 했어요.</li>`);
  if (p.op) items.push(`<li><strong>쉬는 날·이용 시간</strong>: 한국관광공사 관광정보(TourAPI) 상세 정보예요. 바뀔 수 있으니 방문 전에 확인하세요.</li>`);
  items.push(`<li><strong>근거 문장</strong>: 위 수치와 기상청 예보·관광공사 행사 정보·공휴일만 넣어 AI(OpenAI)가 쓴 문장이에요. 문장 속 숫자는 입력 자료와 대조해 맞지 않으면 버리고 정해진 문장으로 바꿔요.${p.review ? " '최근 후기' 내용은 최근 90일 네이버 블로그 글을 AI 가 요약한 것이에요(원문은 저장하지 않아요)." : ""}</li>`);
  return `<ul class="sources">${items.join("")}</ul>`;
}

export async function initPlace() {
  const el = document.getElementById("place")!;
  const q = new URLSearchParams(location.search);
  const id = q.get("id") ?? "";
  if (!/^[\w-]+$/.test(id)) {
    el.innerHTML = "<p>장소 주소가 올바르지 않습니다. <a href='/'>추천 목록</a>에서 다시 골라 주세요.</p>";
    return;
  }
  try {
    const [p, cfg, m] = await Promise.all([getJson<Place>(`place/${id}.json`), config(), meta()]);
    const today = todayKst();
    const days = p.days.filter((d) => d.d >= today);
    const date = days.some((d) => d.d === q.get("date")) ? q.get("date")! : (days[0]?.d ?? p.days[0].d);
    const day = p.days.find((d) => d.d === date)!;
    document.title = `${p.name} — 한산`;
    const back = document.getElementById("back") as HTMLAnchorElement;
    back.href = `/?date=${date}`;
    const cat = cfg.categories.find((c) => c.id === p.cat)?.label ?? p.cat;
    const typeLabel = (t: string) => cfg.types.find((x) => x.id === t)?.label ?? t;

    // 유형·근거 (FR-DTL-04)
    const typesHtml = day.closed
      ? `<p><strong>이 날은 쉬는 날이에요</strong>${day.cr ? ` (${esc(day.cr)})` : ""}.</p>`
      : day.types.length
        ? `<ul>${day.types
            .map((t) => `<li><span class="badge">${esc(typeLabel(t))}</span> ${esc(t === day.rep && day.reason ? day.reason : ruleReason({ pop: p.pop, f: day.f ?? 0, u: day.u, trend: p.trend, lt: p.lt, slot: day.slot }, t))}${t === "hidden_classic" && p.review?.reason ? ` <small>(최근 후기: ${esc(p.review.reason)})</small>` : ""}${t === "timing_game" && day.prov ? " <small>(평소 자료가 아직 적어 임시로 판단했어요)</small>" : ""}</li>`)
            .join("")}</ul>`
        : "<p>이 날은 추천 유형에 해당하지 않아요.</p>";
    const lh = day.lh ? LH_TEXT[day.lh] : null;
    // 화제 이유(FR-DTL-04, FR-LLM-05)와 후기 속 한산한 시간대 언급(FR-LLM-04) — 최근 블로그 후기를 요약한 것
    const buzzHtml = p.review?.buzz ? `<p><strong>요즘 화제</strong> ${esc(p.review.buzz)} <small>(최근 후기 요약)</small></p>` : "";
    // 많이 찾는 이유(2026-10-13 사용자 요청) — 인기 장소(상위 30%)만: 어떤 곳인지 · 요즘 화제 · 인기도를 끌어올린 신호
    let whyHtml = buzzHtml;
    if (p.pop !== null && p.pop >= 70) {
      const why: string[] = [];
      if (p.known) why.push(`<li><strong>어떤 곳</strong> ${esc(p.known)} <small>(한국관광공사 소개 요약)</small></li>`);
      if (p.review?.buzz) why.push(`<li><strong>요즘 화제</strong> ${esc(p.review.buzz)} <small>(최근 후기 요약)</small></li>`);
      why.push(`<li><strong>찾는 사람이 많다는 근거</strong> ${popSignals(p)}</li>`);
      whyHtml = `<h3>많이 찾는 이유</h3><ul class="why">${why.join("")}</ul>`;
    }
    const quietMention = p.review?.quietTime ? `<p>후기에서 말하는 한산한 때: ${esc(p.review.quietTime)} <small>(최근 후기 요약)</small></p>` : "";

    // 14일 표 (FR-DTL-02)
    const rows = days
      .map((d) => {
        const lhd = d.lh ? LH_TEXT[d.lh] : null;
        return `<tr${d.d === date ? ' aria-current="date"' : ""}>
          <th scope="row"><a href="?id=${encodeURIComponent(p.id)}&date=${d.d}">${dateLabel(d.d)}</a></th>
          <td>${d.closed ? "쉬는 날" : d.f === null ? "-" : `<span class="bar" style="width:${Math.round(d.f * 0.8)}px" aria-hidden="true"></span> ${Math.round(d.f)}`}</td>
          <td>${d.u === null ? "-" : Math.round(d.u)}</td>
          <td>${d.closed ? "-" : compare(d.f, d.u)}</td>
          <td>${d.closed || !lhd ? "-" : `<span class="lh-${d.lh}"><span aria-hidden="true">${lhd.mark}</span> ${lhd.text.replace("한산할 가능성 ", "")}</span>`}</td>
        </tr>`;
      })
      .join("");

    // 시간대 패턴 (FR-DTL-03): 그 날짜가 평일인지 휴일인지에 맞는 패턴
    let patternHtml = "<p>이 장소의 시간대 자료가 아직 없어요.</p>";
    if (p.pat) {
      const holiday = [0, 6].includes(weekday(date)) || Boolean(m.holidays?.includes(date));
      const pat = holiday ? p.pat.hd : p.pat.wd;
      const s = day.slot ? Number(day.slot.start.slice(0, 2)) : -1;
      const e = day.slot ? Number(day.slot.end.slice(0, 2)) : -1;
      const label =
        p.pat.label === "실측"
          ? `<span class="badge">실측</span> 서울 실시간 인구 자료로 만든 패턴이에요.`
          : `<details><summary class="badge">추정</summary>이 장소의 시간대별 실측 자료가 없어, 비슷한 장소와 지역 유동인구 자료로 어림했어요.</details>`;
      patternHtml = `<p>${label}</p>
        <div class="hours" role="img" aria-label="시간대별 혼잡 정도 (${holiday ? "주말·휴일" : "평일"})">
          ${pat.map((v, h) => `<span class="${h >= s && h < e ? "quiet" : ""}" style="height:${Math.round((v ?? 0) * 100)}%"></span>`).join("")}
        </div>
        <div class="hour-axis" aria-hidden="true"><span>0시</span><span>6시</span><span>12시</span><span>18시</span><span>23시</span></div>
        ${day.slot ? `<p>추천 시간대: <strong>${day.slot.start}~${day.slot.end}</strong> (가장 붐비는 때의 ${Math.round(day.slot.quietToPeak * 100)}% 수준)</p>` : ""}
        <details><summary>시간대별 수치 보기</summary><p>${pat.map((v, h) => `${h}시 ${v === null ? "-" : Math.round(v * 100)}`).join(", ")}</p></details>`;
    }

    // 근처 대안 (FR-DTL-05)
    const alt = p.alt[date] ?? [];
    const altHtml = alt.length
      ? `<ul>${alt.map(([aid, name, km]) => `<li><a href="?id=${encodeURIComponent(aid)}&date=${date}">${esc(name)}</a> · 약 ${km}km</li>`).join("")}</ul>`
      : "<p>이 날 근처(20km 안)에 한산할 가능성이 높은 다른 장소가 없어요.</p>";

    const name = encodeURIComponent(p.name);
    el.innerHTML = `
      <h1>${esc(p.name)}</h1>
      <dl class="facts">
        <dt>주소</dt><dd>${esc(p.addr || p.area)}</dd>
${p.dong ? `<dt>행정동</dt><dd>${esc(p.dong)}</dd>` : ""}
        ${p.nav ? `<dt>내비 인기</dt><dd>${esc(p.area)} 중심 관광지 ${p.nav.rank}위 <small>(티맵 내비게이션 기준, ${Number(p.nav.ym.slice(0, 4))}년 ${Number(p.nav.ym.slice(4, 6))}월)</small></dd>` : ""}
        <dt>분류</dt><dd>${esc(cat)}</dd>
        <dt>실내·실외</dt><dd>${INDOOR[p.indoor]}</dd>
        <dt>쉬는 날</dt><dd>${p.op?.rest ? esc(p.op.rest) : "정보 없음"}</dd>
        <dt>이용 시간</dt><dd>${p.op?.hours ? esc(p.op.hours) : "정보 없음"}</dd>
      </dl>
      <p class="check">방문 전에 운영 여부와 시간을 꼭 확인하세요. 운영 정보는 바뀔 수 있어요.${day.caution ? " 이 장소는 쉬는 날 안내가 조건에 따라 달라요." : ""}</p>
      <p>지도 앱에서 보기: <a href="https://map.naver.com/p/search/${name}" rel="noopener" target="_blank">네이버 지도</a> · <a href="https://map.kakao.com/link/map/${name},${p.lat},${p.lng}" rel="noopener" target="_blank">카카오맵</a></p>

      <h2>${dateLabel(date)}</h2>
      ${lh && !day.closed ? `<p class="lh-${day.lh}"><span aria-hidden="true">${lh.mark}</span> ${lh.text}</p>` : ""}
      ${day.fs ? `<p class="notice">이 지역의 혼잡 예측이 며칠째 갱신되지 않았어요.</p>` : ""}
      ${typesHtml}
      ${whyHtml}

      <h2>시간대별 붐빔</h2>
      ${patternHtml}
      ${quietMention}

      <h2>앞으로 2주 혼잡 예측</h2>
      <p>숫자가 클수록 붐빈다는 뜻이에요(0~100). 이 장소의 평소 수준과 비교해 보세요.</p>
      <div class="table-wrap"><table>
        <thead><tr><th scope="col">날짜</th><th scope="col">혼잡 예측</th><th scope="col">평소</th><th scope="col">비교</th><th scope="col">한산 가능성</th></tr></thead>
        <tbody>${rows}</tbody>
      </table></div>

      <h2>근처의 한산한 곳</h2>
      ${altHtml}

      <h2>이 정보의 근거와 출처</h2>
      ${sourcesHtml(p, day, m, cfg)}`;
  } catch {
    el.innerHTML = "<p>장소 정보를 불러오지 못했습니다. 주소를 확인하거나 <a href='/'>추천 목록</a>으로 돌아가 주세요.</p>";
  }
}
