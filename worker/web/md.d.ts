// wrangler.toml 의 Text 규칙으로 묶는 프롬프트 파일
declare module "*.md" {
  const text: string;
  export default text;
}
