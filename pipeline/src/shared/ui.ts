// 화면 판단 중 시험해야 하는 순수 함수 — 지연 안내(NFR-REL-02)·대화 응답 표시(FR-CHAT-04·12)·글자 이스케이프
export const LH_TEXT: Record<string, { text: string; mark: string }> = {
  high: { text: "한산할 가능성 높음", mark: "●●●" },
  medium: { text: "한산할 가능성 보통", mark: "●●○" },
  low: { text: "한산할 가능성 낮음", mark: "●○○" },
};

export function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

const minusDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) - n * 86400000).toISOString().slice(0, 10);

// 원자료(혼잡 예측·서울 실시간 인구) 수집 시각이나 계산일이 3일 넘게 지났으면 지연 — 시각이 없으면 지연으로 본다
export function isStale(meta: { asOf: string; updated: Record<string, string | null> }, today: string, days = 3): boolean {
  const limit = minusDays(today, days);
  const old = (iso: string | null | undefined) => !iso || iso.slice(0, 10) < limit;
  return old(meta.updated.forecast) || old(meta.updated.seoul) || meta.asOf < limit;
}

export interface ChatCard {
  id: string;
  name: string;
  area: string;
  lh: "high" | "medium" | "low";
  minutes: number | null;
}

// 대화 응답 한 칸. 카드가 있으면 상세 링크와 '이 조건으로 피드 보기', 실패 응답이면 '지금 조건의 추천 보기'(FR-CHAT-12)
export function chatReplyHtml(r: { ok: boolean; text: string; cards?: ChatCard[] }, date: string, resultFeedUrl: string, currentFeedUrl: string): string {
  const cards = (r.cards ?? [])
    .map((c) => `<li><a href="/place/?id=${encodeURIComponent(c.id)}&date=${encodeURIComponent(date)}">${esc(c.name)}</a> · ${esc(c.area)}${c.minutes !== null ? ` · 약 ${c.minutes}분` : ""} · <span class="lh-${c.lh}">${LH_TEXT[c.lh].text}</span></li>`)
    .join("");
  const link = cards ? `<ul>${cards}</ul><p><a href="${esc(resultFeedUrl)}">이 조건으로 피드 보기</a></p>` : !r.ok ? `<p><a href="${esc(currentFeedUrl)}">지금 조건의 추천 보기</a></p>` : "";
  return `<p>${esc(r.text)}</p>${link}`;
}

// 응답이 오지 않았을 때(10초 초과·네트워크 오류)
export const chatTimeoutHtml = (currentFeedUrl: string) => `<p>응답이 늦어 답을 드리지 못했어요. <a href="${esc(currentFeedUrl)}">지금 조건의 추천 보기</a></p>`;
