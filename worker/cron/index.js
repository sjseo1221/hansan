// GitHub Actions 예약 실행은 지연·누락될 수 있어(2026-10-11 서울 3시간 0회 확인), Cloudflare Cron Trigger 가 워크플로를 직접 실행한다.
// 수집 자체는 GitHub Actions 가 한다. 이 Worker 는 workflow_dispatch API 만 호출한다.
// 비밀 값 GITHUB_TOKEN: hansan 저장소 전용 fine-grained token (Actions: Read and write)

// wrangler.toml 의 crons 와 같은 문자열이어야 한다 (UTC)
export const SCHEDULE = {
  "17 * * * *": "collect-seoul-hourly.yml", // 매시 17분
  "30 19 * * *": "collect-cnctr-daily.yml", // 매일 04:30 KST
  "50 19 * * sun": "build-places-weekly.yml", // 월 04:50 KST
  "23 20 * * *": "collect-naver-weekly.yml", // 매일 05:23 KST (요일 묶음)
  "40 20 * * *": "collect-aux-daily.yml", // 매일 05:40 KST (방문자수·행사·날씨·공휴일·운영 정보)
};

export default {
  async scheduled(controller, env, ctx) {
    const workflow = SCHEDULE[normalize(controller.cron)];
    // 표에 없는 예약은 실패로 남겨 대시보드에서 보이게 한다
    if (!workflow) throw new Error(`알 수 없는 예약: ${controller.cron}`);
    ctx.waitUntil(dispatch(env, workflow));
  },
};

// 요일 표기(SUN·0·7)와 대소문자 차이를 표의 표기로 맞춘다
export function normalize(cron) {
  const f = cron.trim().toLowerCase().split(/\s+/);
  if (f[4] === "0" || f[4] === "7") f[4] = "sun";
  return f.join(" ");
}

async function dispatch(env, workflow) {
  const res = await fetch(`https://api.github.com/repos/${env.REPO}/actions/workflows/${workflow}/dispatches`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.GITHUB_TOKEN}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "hansan-cron",
    },
    body: JSON.stringify({ ref: "main" }),
  });
  // 성공은 204. 실패하면 예외로 끝내 Cloudflare 대시보드의 Cron 실행 기록에 실패로 남긴다
  if (res.status !== 204) throw new Error(`${workflow} 실행 요청 실패: HTTP ${res.status}`);
}
