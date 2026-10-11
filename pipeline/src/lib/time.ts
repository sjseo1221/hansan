// 모든 날짜 경계는 KST 기준 (주기 작업 시각, 하루 호출 상한)
const KST_OFFSET_MS = 9 * 60 * 60 * 1000;

export function kstParts(now: Date) {
  const k = new Date(now.getTime() + KST_OFFSET_MS);
  const p = (n: number) => String(n).padStart(2, "0");
  const yyyy = String(k.getUTCFullYear());
  const mm = p(k.getUTCMonth() + 1);
  const dd = p(k.getUTCDate());
  const hh = p(k.getUTCHours());
  return { yyyy, mm, dd, hh, date: `${yyyy}-${mm}-${dd}` };
}

export function kstIso(now: Date): string {
  const k = new Date(now.getTime() + KST_OFFSET_MS);
  return k.toISOString().replace("Z", "+09:00");
}
