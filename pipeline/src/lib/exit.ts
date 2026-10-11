// 수집 결과 → 종료 코드. 1 이면 워크플로가 실패로 끝나 저장소 소유자에게 알림이 간다 (FR-OPS-04)
export interface RunCounts {
  attempted: number;
  ok: number;
  failed: number;
  skipped: number;
  aborted?: number;
}

export const FAILURE_RATE_LIMIT = 0.5;

export function exitCode(r: RunCounts): 0 | 1 {
  // 하루 상한이 이미 소진돼 한 건도 못 했으면 조용히 끝내지 않는다
  if (r.attempted === 0 && r.skipped > 0) return 1;
  // 연속 실패로 중단했으면 알린다
  if ((r.aborted ?? 0) > 0) return 1;
  // 시도 대비 실패율이 기준을 넘으면 알린다
  if (r.attempted > 0 && r.failed / r.attempted > FAILURE_RATE_LIMIT) return 1;
  return 0;
}
