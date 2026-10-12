// 휴무일 해석(FR-TYPE-08) — TourAPI 운영 정보의 휴무 문장(자유 서술)을 규칙으로 읽는다.
// 확실히 쉬는 날만 '휴무'로 본다. 조건부·불명확한 문장은 열려 있다고 보고 operationCaution 을 단다(추천에서 잘못 빼지 않게)
import { addDays, compact, weekday } from "./stats.js";

const WD = "일월화수목금토";
const ORD: Record<string, number> = { 첫: 1, 첫째: 1, "1": 1, 둘째: 2, 두: 2, "2": 2, 셋째: 3, 세: 3, "3": 3, 넷째: 4, 네: 4, "4": 4, 마지막: -1 };
const ORD_WORD = "(?:첫째|첫|둘째|두|셋째|세|넷째|네|마지막|[1-4])\\s*(?:번째|째)?";
// 조건부 문구 — 휴무가 확실하지 않다(일부 시설·기간 한정·점포별·월 범위 계절 구분 등). "전화 문의"·"홈페이지 참고" 같은 안내는 조건이 아니다
const CONDITIONAL = /격주|점포|상이|기상|제외|변동|사정|시즌|동절기|하절기|성수기|비수기|임시|부정기|일부|통제|기간|신청|\d+\s*월[^/\]\n]*?~\s*\d*\s*월/;
// "X요일이 공휴일인 경우 …" 처럼 공휴일 예외를 말하는 요일 — 매주 휴무 요일로 세지 않는다
const WEEKDAY_HOLIDAY = /[일월화수목금토]요일이?\s*(?:법정\s*)?(?:공휴일|대체공휴일)/g;

export interface ClosedResult {
  closed: boolean;
  reason?: string;
  caution: boolean;
}

export function closedOn(rest: string | null | undefined, date: string, holidays: Record<string, string>): ClosedResult {
  if (!rest || !rest.trim()) return { closed: false, caution: false };
  const t = rest.replace(/\s+/g, " ");
  if (/^(연중\s*무휴|연중\s*개방|없음|무휴|-)$/.test(t.trim())) return { closed: false, caution: false };
  const d = compact(date);
  const w = weekday(date);
  const isHoliday = (x: string) => Boolean(holidays[compact(x)]);
  const off = (x: string) => isHoliday(x) || [0, 6].includes(weekday(x));
  const reasons: string[] = [];

  // 공휴일 예외: "공휴일인 경우 개관·개방·정상 운영" → 그날은 매주 휴무 요일이어도 연다.
  // "그 다음 (첫 번째) 평일·비공휴일 / 익일 대체 휴관" → 휴무를 다음 평일로 옮긴다
  const holidayOpen = /공휴일[^/]*?(?:개관|개방|개장|운영)/.test(t);
  const shift = /공휴일[^/]*?(?:다음|익일|첫\s*번째\s*(?:평일|비공휴일))/.test(t);

  // 매주 휴무 요일: "매주 월요일", "월요일, 화요일", "월~금", "주말"
  const days = new Set<number>();
  const plain = t
    .replace(new RegExp(`(?:매월|매달)?\\s*${ORD_WORD}(?:\\s*[,·/]\\s*${ORD_WORD})*\\s*(?:주\\s*)?[일월화수목금토]요일`, "g"), " ")
    .replace(WEEKDAY_HOLIDAY, " ");
  for (const m of plain.matchAll(/([일월화수목금토])\s*(?:요일)?\s*~\s*([일월화수목금토])(?:요일)?/g)) {
    for (let i = WD.indexOf(m[1]); ; i = (i + 1) % 7) {
      days.add(i);
      if (i === WD.indexOf(m[2])) break;
    }
  }
  for (const m of plain.matchAll(/([일월화수목금토](?:\s*[·,/]\s*[일월화수목금토])*)\s*요일/g)) for (const c of m[1].replace(/[^일월화수목금토]/g, "")) days.add(WD.indexOf(c));
  if (/주말/.test(t)) [0, 6].forEach((x) => days.add(x));
  if (days.has(w) && !((holidayOpen || shift) && isHoliday(date))) reasons.push(`${WD[w]}요일`);
  // 옮겨진 휴무: 직전 휴무 요일이 공휴일이었고, 그 뒤 오늘 전까지 모두 공휴일·주말, 오늘은 공휴일 아닌 평일
  if (shift && !off(date)) {
    for (let x = addDays(date, -1); off(x); x = addDays(x, -1)) {
      if (days.has(weekday(x)) && isHoliday(x)) {
        reasons.push("공휴일 다음 평일");
        break;
      }
    }
  }

  // 매월 N째 X요일 — "첫째, 셋째 일요일" 처럼 서수를 나열해도 모두 본다
  for (const m of t.matchAll(new RegExp(`(${ORD_WORD}(?:\\s*[,·/]\\s*${ORD_WORD})*)\\s*(?:주\\s*)?([일월화수목금토])요일`, "g"))) {
    if (WD.indexOf(m[2]) !== w) continue;
    const dom = Number(d.slice(6, 8));
    const lastOfMonth = addDays(date, 7).slice(5, 7) !== date.slice(5, 7);
    for (const o of m[1].split(/\s*[,·/]\s*/)) {
      const n = ORD[o.replace(/\s*(?:번째|째)$/, "").trim()] ?? ORD[o.trim()];
      if (n === Math.ceil(dom / 7) || (n === -1 && lastOfMonth)) reasons.push(`매월 ${o.trim()} ${m[2]}요일`);
    }
  }
  // 매월 N일 (나열 포함: "매월 10일, 20일, 30일") · M월 D일
  // "N일이 휴일·공휴일이면 다음 평일" — 그날이 쉬는 날이면 다음 평일로 옮긴다
  const monthlyShift = /(?:휴일|공휴일|연휴)[^/]*?(?:다음|익일)/.test(t);
  for (const m of t.matchAll(/(?:매월|매달)\s*((?:\d{1,2}\s*일\s*[,·]?\s*)+)/g)) {
    for (const n of m[1].match(/\d{1,2}/g) ?? []) {
      let target = `${date.slice(0, 8)}${n.padStart(2, "0")}`;
      if (monthlyShift) while (off(target)) target = addDays(target, 1);
      if (target === date) reasons.push(`매월 ${n}일`);
    }
  }
  for (const m of t.matchAll(/(\d{1,2})\s*월\s*(\d{1,2})\s*일/g)) if (Number(m[1]) === Number(d.slice(4, 6)) && Number(m[2]) === Number(d.slice(6, 8))) reasons.push(`${m[1]}월 ${m[2]}일`);
  // 설·추석 — '시설' 의 '설' 은 아니다. "설·추석 연휴 운영" 은 여는 날
  const name = holidays[d] ?? "";
  const seollal = /설\s*[·,/]|설날|설\s*(?:연휴|당일|전일)|구정/.test(t);
  const festOpen = /(?:설|추석)[^/]*?(?:운영|개관|개방|개장)/.test(t);
  if (!festOpen && seollal && /설날/.test(name)) reasons.push("설날");
  if (!festOpen && /추석/.test(t) && /추석/.test(name)) reasons.push("추석");
  // 공휴일 자체가 휴무 ("법정 공휴일", "공휴일 다음날")
  if (/공휴일\s*(?:다음\s*날|익일)/.test(t) && isHoliday(addDays(date, -1)) && !isHoliday(date)) reasons.push("공휴일 다음날");
  else if (!holidayOpen && !shift && /공휴일/.test(t.replace(WEEKDAY_HOLIDAY, "")) && isHoliday(date)) reasons.push("공휴일");

  const conditional = CONDITIONAL.test(t);
  // 날짜와 상관없이 문장 자체를 알아들었는지 — 못 알아들은 문장은 열림 + 주의
  const understood = days.size > 0 || /매월|매달|\d+\s*월\s*\d+\s*일|설|추석|공휴일|연중|무휴|개방/.test(t);
  if (reasons.length && !conditional) return { closed: true, reason: [...new Set(reasons)].join(", "), caution: false };
  return { closed: false, caution: conditional || !understood };
}
