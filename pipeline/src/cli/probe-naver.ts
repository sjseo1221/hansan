// NAVER API HUB 실호출 확인 도구 (RFP 6절). 상태·응답 구조만 출력하고 인증 값은 출력하지 않는다.
import { existsSync } from "node:fs";

if (existsSync(".env")) process.loadEnvFile(".env");
const id = process.env.NAVER_CLIENT_ID;
const secret = process.env.NAVER_CLIENT_SECRET;
if (!id || !secret) {
  console.error("NAVER_CLIENT_ID / NAVER_CLIENT_SECRET 이 없습니다.");
  process.exit(1);
}

const HOST = "https://naverapihub.apigw.ntruss.com";
const auth = { "X-NCP-APIGW-API-KEY-ID": id, "X-NCP-APIGW-API-KEY": secret };

async function call(name: string, url: string, init: RequestInit) {
  try {
    const res = await fetch(url, { ...init, signal: AbortSignal.timeout(20000) });
    const text = await res.text();
    let body: any;
    try {
      body = JSON.parse(text);
    } catch {
      body = { raw: text.slice(0, 200) };
    }
    const out: Record<string, unknown> = { probe: name, status: res.status };
    if (body.items) {
      out.total = body.total;
      out.itemKeys = body.items[0] ? Object.keys(body.items[0]) : [];
      out.sample = body.items[0] ?? null;
    } else if (body.results) {
      out.periods = body.results[0]?.data?.length ?? 0;
      out.results = body.results.map((r: any) => ({ title: r.title, first: r.data?.[0], last: r.data?.at(-1) }));
    } else {
      out.body = body;
    }
    // 사용량 관련 응답 헤더가 있으면 함께 본다
    out.headers = Object.fromEntries([...res.headers].filter(([k]) => /limit|remain|quota|rate/i.test(k)));
    console.log(JSON.stringify(out));
  } catch (e) {
    console.log(JSON.stringify({ probe: name, error: (e as Error).name }));
  }
}

const q = encodeURIComponent("경복궁");
await call("블로그 검색(정확도)", `${HOST}/search/v1/blog?query=${q}&display=3&sort=sim`, { headers: auth });
await call("블로그 검색(최신)", `${HOST}/search/v1/blog?query=${q}&display=3&sort=date`, { headers: auth });

const body = {
  startDate: "2016-01-01",
  endDate: new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10),
  timeUnit: "month",
  keywordGroups: [
    { groupName: "기준", keywords: ["경복궁"] },
    { groupName: "남산서울타워", keywords: ["남산서울타워", "N서울타워"] },
    { groupName: "서울숲", keywords: ["서울숲"] },
    { groupName: "에버랜드", keywords: ["에버랜드"] },
    { groupName: "남이섬", keywords: ["남이섬"] },
  ],
};
await call("검색어 트렌드(월·5그룹·2016~)", `${HOST}/search-trend/v1/search`, {
  method: "POST",
  headers: { ...auth, "Content-Type": "application/json" },
  body: JSON.stringify(body),
});
