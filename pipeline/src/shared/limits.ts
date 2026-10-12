// 대화 상한 판정(FR-CHAT-08·09, NFR-COST-03) — Worker 의 카운터가 쓰는 순수 함수(시험용으로 분리)
export type TakeResult = "ok" | "closed" | "user_limit";

export function decideTake(s: { service: number; cost: number; user: number }, l: { perUser: number; serviceDaily: number; cutoff: number }): TakeResult {
  // 서비스 하루 상한·월 예산 차단선에 닿으면 대화를 닫는다(피드·상세는 정적 파일이라 영향 없음)
  if (s.service >= l.serviceDaily || s.cost >= l.cutoff) return "closed";
  if (s.user >= l.perUser) return "user_limit";
  return "ok";
}

// 이용 집계 종류(FR-OPS-06) — 개인 식별 정보 없이 날짜별 수만 센다
export const HIT_KINDS = ["visit", "detail", "chat"] as const;
export type HitKind = (typeof HIT_KINDS)[number];
