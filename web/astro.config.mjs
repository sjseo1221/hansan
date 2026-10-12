// 한산 화면 — 정적 출력. 자료는 브라우저가 /data/* 에서 읽는다(Worker 가 public-data 브랜치를 프록시)
import { defineConfig } from "astro/config";

export default defineConfig({
  output: "static",
  outDir: "./dist",
  trailingSlash: "ignore",
  build: { format: "directory" },
});
