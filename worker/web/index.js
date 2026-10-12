// 한산 화면 Worker — 정적 화면(web/dist)을 내보내고, /data/*.json 은 GitHub 공개 저장소의 public-data 브랜치에서 가져온다.
// 자료는 compute-daily 가 매일 그 브랜치에 올리므로 화면을 다시 배포하지 않아도 최신 자료가 보인다. 비밀 값 없음
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/data/")) {
      const path = url.pathname.slice("/data/".length);
      // 정해진 모양의 JSON 경로만 — 다른 파일·상위 경로 접근 차단
      if (!/^[A-Za-z0-9_\-/]+\.json$/.test(path) || path.includes("..") || path.includes("//")) return new Response("Not found", { status: 404 });
      const res = await fetch(`https://raw.githubusercontent.com/${env.REPO}/public-data/${path}`, { cf: { cacheTtl: 300, cacheEverything: true } });
      if (!res.ok) return new Response(res.status === 404 ? "Not found" : "Upstream error", { status: res.status === 404 ? 404 : 502 });
      return new Response(res.body, {
        headers: { "content-type": "application/json; charset=utf-8", "cache-control": "public, max-age=300", "x-content-type-options": "nosniff" },
      });
    }
    return env.ASSETS.fetch(request);
  },
};
