// 휴무일 해석(FR-TYPE-08) — TourAPI 운영 정보의 휴무 문장(자유 서술)을 규칙으로 읽는다.
// 확실히 쉬는 날만 '휴무'로 본다. 조건부·불명확한 문장은 열려 있다고 보고 operationCaution 을 단다(추천에서 잘못 빼지 않게)
import { addDays, compact, weekday } from "./stats.js";

const WD = "일월화수목금토";
const ORD: Record<string, number> = { 첫: 1, 첫째: 1, "1": 1, 둘째: 2, 두: 2, "2": 2, 셋째: 3, 세: 3, "3": 3, 넷째: 4, 네: 4, "4": 4, 마지막: -1 };
// 조건부 문구 — 휴무가 확실하지 않다(일부 시설·기간 한정·점포별 등). "전화 문의"·"홈페이지 참고" 같은 안내는 조건이 아니다
const CONDITIONAL = /격주|점포|상이|기상|제외|변동|사정|시즌|동절기|하절기|성수기|비수기|임시|부정기|일부|통제|기간/;

export interface ClosedResult {
  closed: boolean;
  reason?: string;
  caution: boolean;
}

export function closedOn(rest: string | null | undefined, date: string, holidays: Record<string, string>): ClosedResult {
  if (!rest || !rest.trim()) return { closed: false, caution: false };
  const t = rest.replace(/\s+/g, " ");
  if (/^(연중\s*무휴|없음|무휴|-)$/.test(t.trim())) return { closed: false, caution: false };
  const d = compact(date);
  const w = weekday(date);
  const isHoliday = (x: string) => Boolean(holidays[compact(x)]);
  const reasons: string[] = [];

  // "X요일이 공휴일인 경우 다음 평일" — 그 요일이 공휴일이면 쉬지 않고 다음 비공휴일에 쉰다
  const shift = t.match(/([일월화수목금토])요일이?\s*(?:법정\s*)?공휴일[^,.]*?(?:다음|익일)/);
  const shiftDay = shift ? WD.indexOf(shift[1]) : -1;

  // 요일: "매주 월요일", "월·화요일", "월~금", "주말"
  const days = new Set<number>();
  for (const m of t.matchAll(/([일월화수목금토])\s*~\s*([일월화수목금토])(?:요일)?/g)) {
    for (let i = WD.indexOf(m[1]); ; i = (i + 1) % 7) {
      days.add(i);
      if (i === WD.indexOf(m[2])) break;
    }
  }
  // 날짜 표현("매월 첫째 수요일", "X요일이 공휴일인 경우")에 쓰인 요일은 매주 휴무가 아니다
  const plain = t
    .replace(/(?:매월|매달)?\s*(?:첫|첫째|둘째|두|셋째|세|넷째|네|마지막|[1-4])\s*(?:번째|째)?\s*(?:주\s*)?[일월화수목금토]요일/g, " ")
    .replace(/[일월화수목금토]요일이?\s*(?:법정\s*)?공휴일/g, " ");
  for (const m of plain.matchAll(/([일월화수목금토](?:\s*[·,/]\s*[일월화수목금토])*)\s*요일/g)) for (const c of m[1].replace(/[^일월화수목금토]/g, "")) days.add(WD.indexOf(c));
  if (/주말/.test(t)) [0, 6].forEach((x) => days.add(x));
  if (days.has(w) && !(w === shiftDay && isHoliday(date))) reasons.push(`${WD[w]}요일`);
  if (shiftDay >= 0) {
    // 직전 그 요일이 공휴일이었고, 그 뒤 오늘 전까지가 모두 공휴일·주말이며 오늘이 공휴일 아닌 평일이면 오늘이 옮겨진 휴무일
    const off = (x: string) => isHoliday(x) || [0, 6].includes(weekday(x));
    let x = addDays(date, -1);
    while (weekday(x) !== shiftDay && off(x)) x = addDays(x, -1);
    if (weekday(x) === shiftDay && isHoliday(x) && !off(date)) reasons.push("공휴일 다음 평일");
  }

  // 매월 N째 X요일
  for (const m of t.matchAll(/(?:매월|매달)?\s*(첫|첫째|둘째|두|셋째|세|넷째|네|마지막|[1-4])\s*(?:번째|째)?\s*(?:주\s*)?([일월화수목금토])요일/g)) {
    const n = ORD[m[1]];
    if (WD.indexOf(m[2]) !== w) continue;
    const dom = Number(d.slice(6, 8));
    const nth = Math.ceil(dom / 7);
    const lastOfMonth = addDays(date, 7).slice(5, 7) !== date.slice(5, 7);
    if (nth === n || (n === -1 && lastOfMonth)) reasons.push(`매월 ${m[1]} ${m[2]}요일`);
  }
  // 매월 N일 · M월 D일
  for (const m of t.matchAll(/매월\s*(\d{1,2})\s*일/g)) if (Number(m[1]) === Number(d.slice(6, 8))) reasons.push(`매월 ${m[1]}일`);
  for (const m of t.matchAll(/(\d{1,2})\s*월\s*(\d{1,2})\s*일/g)) if (Number(m[1]) === Number(d.slice(4, 6)) && Number(m[2]) === Number(d.slice(6, 8))) reasons.push(`${m[1]}월 ${m[2]}일`);
  // 설·추석
  const name = holidays[d] ?? "";
  if (/설/.test(t) && /설날/.test(name)) reasons.push("설날");
  if (/추석/.test(t) && /추석/.test(name)) reasons.push("추석");
  // 공휴일 다음날 / 공휴일 (단, "공휴일 개관·정상 운영" 은 아님)
  if (/공휴일\s*(?:다음\s*날|익일)/.test(t) && isHoliday(addDays(date, -1)) && !isHoliday(date)) reasons.push("공휴일 다음날");
  else if (shiftDay < 0 && /공휴일/.test(t) && !/공휴일[^,.]*(?:개관|개장|운영|정상|다음|익일)/.test(t) && isHoliday(date)) reasons.push("공휴일");

  const conditional = CONDITIONAL.test(t);
  // 날짜와 상관없이 문장 자체를 알아들었는지 — 못 알아들은 문장은 열림 + 주의
  const understood = days.size > 0 || shiftDay >= 0 || /매월|매달|\d+\s*월\s*\d+\s*일|설|추석|공휴일|연중|무휴/.test(t);
  if (reasons.length && !conditional) return { closed: true, reason: reasons.join(", "), caution: false };
  return { closed: false, caution: conditional || !understood };
}
