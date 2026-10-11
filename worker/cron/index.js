// GitHub Actions 예약 실행은 지연·누락될 수 있어, Cloudflare Cron Trigger 가 매시간 워크플로를 직접 실행한다.
// 수집 자체는 GitHub Actions 가 한다. 이 Worker 는 workflow_dispatch API 만 호출한다.
// 비밀 값 GITHUB_TOKEN: hansan 저장소 전용 fine-grained token (Actions: Read and write)
export default {
  async scheduled(controller, env, ctx) {
    ctx.waitUntil(dispatch(env));
  },
};

async function dispatch(env) {
  const res = await fetch(`https://api.github.com/repos/${env.REPO}/actions/workflows/${env.WORKFLOW}/dispatches`, {
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
  if (res.status !== 204) throw new Error(`workflow dispatch 실패: HTTP ${res.status}`);
}
