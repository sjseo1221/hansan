// 대화 창(FR-CHAT-01·04·05·10·12) — 서버(/api/chat)가 조건을 해석하고 미리 계산된 추천에서 고른다. 대화 내용은 이 창 안에만 있다
import { chatReplyHtml, chatTimeoutHtml, type ChatCard } from "../../../pipeline/src/shared/ui";
import { esc } from "./common";

interface Reply {
  ok: boolean;
  closed?: boolean;
  offTopic?: boolean;
  text: string;
  filters?: Record<string, string | number | null | string[]>;
  cards?: ChatCard[];
}

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

// 지금 화면의 필터(피드 주소) — 대화의 기본 조건(FR-CHAT-02)
function currentFilters(): Record<string, string | number | null | string[]> {
  const q = new URLSearchParams(location.pathname === "/" ? location.search : "");
  return { date: q.get("date"), origin: q.get("origin"), minutes: q.get("minutes") ? Number(q.get("minutes")) : null, companion: q.get("companion"), indoor: q.get("indoor") };
}

const feedUrl = (f: Record<string, string | number | null | string[]>) => {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(f)) if (k !== "types" && v !== null && v !== undefined && v !== "") q.set(k, String(v));
  return `/?${q}`;
};

export async function initChat() {
  const open = $<HTMLButtonElement>("chat-open");
  const dlg = $<HTMLDialogElement>("chat");
  const log = $("chat-log");
  const form = $<HTMLFormElement>("chat-form");
  const input = $<HTMLInputElement>("chat-input");
  try {
    const st = (await (await fetch("/api/chat/status")).json()) as { open: boolean };
    if (!st.open) return; // 닫혀 있으면 버튼을 보이지 않는다(피드 이용, FR-CHAT-09)
  } catch {
    return;
  }
  open.hidden = false;
  let filters = currentFilters();
  open.addEventListener("click", () => {
    filters = currentFilters();
    dlg.showModal();
    input.focus();
  });
  $("chat-close").addEventListener("click", () => dlg.close());

  const say = (who: "me" | "bot", html: string) => {
    log.insertAdjacentHTML("beforeend", `<div class="msg ${who}">${html}</div>`);
    log.scrollTop = log.scrollHeight;
  };

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const message = input.value.trim().slice(0, 200);
    if (!message) return;
    input.value = "";
    say("me", esc(message));
    const btn = form.querySelector("button")!;
    btn.disabled = true;
    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message, current: filters }),
        signal: AbortSignal.timeout(10000),
      });
      const r = (await res.json()) as Reply;
      if (r.filters) filters = r.filters; // 다음 질문은 이 조건을 이어받는다(FR-CHAT-05)
      say("bot", chatReplyHtml(r, String(filters.date ?? ""), feedUrl(filters), feedUrl(currentFilters())));
      if (r.closed) {
        form.hidden = true;
        open.hidden = true;
      }
    } catch {
      // 실패·10초 초과 — 안내하고 지금 조건의 피드를 보여 준다(FR-CHAT-12)
      say("bot", chatTimeoutHtml(feedUrl(currentFilters())));
    } finally {
      btn.disabled = false;
    }
  });
}
