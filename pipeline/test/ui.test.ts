// 화면 판단 시험 — 지연 안내(NFR-REL-02), 대화 실패 시 피드 안내(FR-CHAT-12), 카드·이스케이프(FR-CHAT-04)
import { describe, expect, it } from "vitest";
import { chatReplyHtml, chatTimeoutHtml, isStale } from "../src/shared/ui.js";

describe("지연 안내 (NFR-REL-02: 3일 넘게)", () => {
  const meta = (forecast: string | null, seoul: string | null, asOf = "2026-10-20") => ({ asOf, updated: { forecast, seoul, search: null } });
  it("수집 시각이 3일 이내면 안내 없음, 넘으면 안내", () => {
    expect(isStale(meta("2026-10-17T04:30:00+09:00", "2026-10-20T12:17:00+09:00"), "2026-10-20")).toBe(false);
    expect(isStale(meta("2026-10-16T04:30:00+09:00", "2026-10-20T12:17:00+09:00"), "2026-10-20")).toBe(true);
  });
  it("계산은 매일 돌아도 수집이 멈췄으면 안내, 시각이 없어도 안내", () => {
    expect(isStale(meta("2026-10-10T04:30:00+09:00", "2026-10-20T12:17:00+09:00", "2026-10-20"), "2026-10-20")).toBe(true);
    expect(isStale(meta(null, "2026-10-20T12:17:00+09:00"), "2026-10-20")).toBe(true);
    expect(isStale(meta("2026-10-20T04:30:00+09:00", "2026-10-20T12:17:00+09:00", "2026-10-15"), "2026-10-20")).toBe(true);
  });
});

describe("대화 응답 표시 (FR-CHAT-04·12)", () => {
  it("카드는 상세 링크와 '이 조건으로 피드 보기', 이름은 이스케이프", () => {
    const h = chatReplyHtml({ ok: true, text: "골랐어요", cards: [{ id: "kto-1", name: "<b>공원</b>", area: "서울 종로구", lh: "high", minutes: 30 }] }, "2026-10-17", "/?date=2026-10-17&companion=kids", "/?date=2026-10-17");
    expect(h).toContain('href="/place/?id=kto-1&date=2026-10-17"');
    expect(h).toContain("&lt;b&gt;공원&lt;/b&gt;");
    expect(h).toContain("약 30분");
    expect(h).toContain("이 조건으로 피드 보기");
  });
  it("실패 응답이면 지금 조건의 추천으로 안내, 시간 초과도 같다", () => {
    const h = chatReplyHtml({ ok: false, text: "답을 만들지 못했어요." }, "2026-10-17", "/?x=1", "/?date=2026-10-17");
    expect(h).toContain('<a href="/?date=2026-10-17">지금 조건의 추천 보기</a>');
    expect(chatTimeoutHtml("/?date=2026-10-17")).toContain("지금 조건의 추천 보기");
  });
  it("정상인데 카드가 없으면(무관 요청 안내 등) 링크 없이 문구만", () => {
    expect(chatReplyHtml({ ok: true, text: "나들이 추천만 도와드려요" }, "2026-10-17", "/?a", "/?b")).toBe("<p>나들이 추천만 도와드려요</p>");
  });
});
