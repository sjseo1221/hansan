# 한산

인기도에 비해 덜 붐비는 나들이 장소를 근거와 함께 추천하는 반응형 웹 (MVP 개발 중).

- 구조: GitHub Actions 주기 작업이 공공·네이버 데이터를 모아 점수와 추천 결과를 파일로 만들고, Cloudflare 정적 화면이 그 파일을 읽는다. 실시간 서버 처리는 대화 기능뿐이다.
- 운영 방법: [docs/ops.md](docs/ops.md)

## 개발

```bash
npm ci
npm test
cp .env.example .env   # 로컬 수집 시험용 키 입력 (git 제외)
npm run collect:seoul
```

## 데이터 출처

- 서울 실시간 인구: 서울 열린데이터광장 (OA-21778)
