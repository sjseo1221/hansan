# 한산 운영 문서

서비스 주소 https://hansan-web.sjseo1221.workers.dev · 저장소 https://github.com/sjseo1221/hansan · 마지막 갱신 2026-10-12

운영자 관리 화면은 없다. 운영 작업은 **설정·데이터 파일을 고쳐 커밋**하는 것으로 한다(FR-OPS-05). 이 문서만 보고 장소 숨김·기준값 변경·키 교체·재배포를 할 수 있게 쓴다.

---

## 1. 구조

```
[공공 API·네이버·OpenAI] ──(GitHub Actions 주기 작업)──> 저장소 data/ (main 브랜치)
        ▲                                         │
 Cloudflare Worker hansan-cron                    ├─ compute-daily: 점수·유형·근거 문장 → public-out/
 (시각마다 워크플로 실행 요청)                      │                                   │
                                                  │                    public-data 브랜치(생성물, 매일 덮어씀)
                                                  ▼                                   ▼
                                      docs/reports/weekly (주간 리포트)   Cloudflare Worker hansan-web
                                                                          ├─ 화면(web/dist 정적 파일)
                                                                          ├─ /data/* → public-data 프록시
                                                                          └─ /api/chat 대화(OpenAI), 상한 카운터(Durable Object)
```

| 구성 | 위치 | 하는 일 |
|---|---|---|
| 수집·계산 코드 | `pipeline/src/` | 수집기(`collect/`), 장소 목록(`places/`), 점수·유형(`score/`), 근거 문장(`llm/`), 주간 리포트(`report/`), 실행 진입점(`cli/`) |
| 화면 | `web/` (Astro 정적) | 피드 `/`, 장소 상세 `/place/?id=…`, 대화 창 |
| 화면 Worker | `worker/web/` | 정적 화면 + 자료 프록시 + 대화 + 이용 집계 |
| 예약 Worker | `worker/cron/` | 정해진 시각에 GitHub 워크플로를 실행(무료 플랜 Cron 5개) |
| 설정 | `config/*.yaml` | 기준값·분류·동행·지역·OpenAI·호출 상한 |
| 프롬프트 | `prompts/*.md` | 근거 문장·후기 판정·대화 지시문(FR-LLM-09) |
| 자료 | `data/` | 원자료(`raw/`)·최신값(`latest/`)·장소(`places/`)·점수(`scores/`)·추천(`recommendations/`)·상태(`state/`)·보고(`reports/`) |

## 2. 주기 작업

모든 시각은 KST. 예약은 Cloudflare Worker `hansan-cron` 이 GitHub 워크플로를 실행한다(GitHub 예약은 지연·누락이 잦아 서울만 보조로 둔다).

| 워크플로 | 시각 | 내용 |
|---|---|---|
| collect-seoul-hourly | 매시 17분 | 서울 121곳 실시간 인구 → `data/raw/seoul_citydata/`, `data/latest/seoul_citydata.json`. 같은 시간대에 이미 시도했으면 건너뜀(강제는 `FORCE=1`) |
| collect-cnctr-daily | 04:30 | 관광지 집중률 30일 예측 → `data/latest/cnctr.json`, 당일 값 `data/raw/cnctr_history/` 누적 |
| build-places-weekly | 월 04:50 | TourAPI 후보와 집중률 관광지 이름 매칭 → `data/places/places.json`, `report.json`. 보이는 장소가 30% 넘게 줄면 바꾸지 않고 실패 |
| collect-naver-weekly | 05:23 | 장소를 요일별 7묶음으로 나눠 장소마다 주 1회: 블로그 게시글 수(제목·요약 저장 안 함), 검색어 트렌드 |
| collect-aux-daily | 05:40 | 방문자수·행사·날씨·공휴일·운영 정보, 중심 관광지(티맵 내비 순위, 월 1회). 일부만 수동 실행: Run workflow 의 only 에 `hub` 등 |
| compute-daily | collect-aux-daily 끝난 뒤(약 06:00), 보조 예약 07:15 | 계산 → 후기 판정(OpenAI) → 계산 → 근거 문장(OpenAI) → 계산 → 주간 리포트(지난주 것이 없을 때) → `public-data` 발행 → `data/` 커밋 |
| test | push 시 | 타입 검사(pipeline·web·worker)·자동 시험 |

실패하면 GitHub 이 저장소 소유자에게 메일을 보낸다(FR-OPS-04). OpenAI 단계·주간 리포트는 실패해도 화면 발행은 계속한다(정형 문장 사용).

## 3. 비밀 값과 키 교체

비밀 값은 저장소·로그·채팅에 쓰지 않는다. 교체는 **같은 이름으로 새 값을 저장**하면 다음 실행부터 적용된다.

| 이름 | 어디에 | 용도 | 교체 방법 |
|---|---|---|---|
| SEOUL_OPENAPI_KEY | GitHub Secrets | 서울 실시간 인구 | 저장소 Settings > Secrets and variables > Actions > 해당 이름 Update |
| DATA_GO_KR_KEY | GitHub Secrets | 공공데이터포털(TourAPI·집중률·방문자수·기상청·특일) | 위와 같음 |
| NAVER_CLIENT_ID, NAVER_CLIENT_SECRET | GitHub Secrets | NAVER API HUB | 위와 같음 |
| OPENAI_API_KEY | GitHub Secrets **와** Worker `hansan-web` | 근거 문장·후기 판정 / 대화 | GitHub: 위와 같음. Worker: `cd worker/web && npx wrangler secret put OPENAI_API_KEY` |
| CHAT_SALT | Worker `hansan-web` | 대화 이용자 횟수 키(IP HMAC) | 아무 긴 무작위 문자열. `npx wrangler secret put CHAT_SALT` (바꾸면 그날 이용 횟수가 처음부터 다시 셈) |
| GITHUB_TOKEN | Worker `hansan-cron` | 워크플로 실행 요청 | GitHub > Settings > Developer settings > Fine-grained token(저장소 `hansan`만, Actions 읽기·쓰기) 새로 만들고 `cd worker/cron && npx wrangler secret put GITHUB_TOKEN`. **만료일 전에** 교체 |

키가 노출됐으면 발급처에서 즉시 폐기·재발급하고 위 방법으로 바꾼다. 서울 API 는 http 만 지원해 키가 암호화 없이 전송된다(무과금 키, 다른 곳에 재사용하지 않음).

## 4. 장소 추가·숨김·수정 (FR-OPS-05)

`data/places/places.json` 은 매주 다시 만드는 생성 파일이다. **`data/places/overrides.yaml` 만 고친다.**

예 — 장소 숨김:

```yaml
places:
  kto-2820721:
    hidden: true        # 다음 계산부터 추천·수집에서 빠진다
```

| 하려는 일 | 쓰는 곳 |
|---|---|
| 숨김 | `places.<장소 번호>.hidden: true` |
| 이름·분류·실내외·네이버 검색어 수정 | `places.<장소 번호>` 아래 `name`·`category`·`indoor`·`keyword` |
| 잘못 연결된 매칭 끊기 / 수동 연결 | `matches` 에 `{ signguCd, tAtsNm, contentId }` (`contentId: null` 이면 연결 끊기). 연결 안 된 목록은 `data/places/report.json` 의 `unmatched.list` |
| 집중률에 없는 장소 추가 | `add` 에 장소 항목(필드는 `places.json` 의 다른 장소와 같게) |

장소 번호는 화면 상세 주소의 `id=` 값이다(예: `/place/?id=kto-644085`). 커밋하면 다음 월요일 `build-places-weekly` 에 반영된다. 바로 반영하려면 GitHub Actions 에서 `build-places-weekly` → `compute-daily` 를 차례로 수동 실행한다(Run workflow).

### 정기 축제 추가

공공데이터(관광공사 행사·서울시 문화행사)에 없는 축제는 `data/sources/festivals-manual.yaml` 에 적는다. 예: 잠수교 뚜벅뚜벅 축제(매주 일요일 `weekdays: [0]`). 다음 `compute-daily` 부터 피드의 '이 날 열리는 축제'에 나온다.

## 5. 기준값 변경

값을 바꾸고 커밋하면 다음 `compute-daily` 부터 적용된다. push 하면 `test` 가 파일끼리 어긋나지 않는지·상한이 무료 한도 안인지 검사한다.

예 — 적당한 핫플 인기도 기준을 70 → 65:

```yaml
# config/thresholds.yaml
types:
  moderate_hotspot:
    popularityMin: 65
```

| 파일 | 내용 |
|---|---|
| `config/thresholds.yaml` | 인기도 가중치(검색 0.5·블로그 0.3·내비 0.2), 유형 판정 기준값, 대표 유형 순서, 한산 가능성 구간(40·60), 피드 유형당 수(10), 연속 노출 제한, 평소 혼잡 기간, 추세·장기 계산, 시간대 공략 방문 창, 적중률 기준 |
| `config/categories.yaml` | 장소 분류 8종, 서울 장소 카테고리 연결, TourAPI 분류 연결 |
| `config/companions.yaml` | 동행 5종 × 분류 적합 표 |
| `config/regions.yaml` | 대상 시·도, 이동 시간 계수(직선거리 × 1.3 ÷ 40km/h) |
| `config/llm.yaml` | OpenAI 모델·단가·월 예산($20)·대화 차단선($15)·생성 상한($5)·대화 횟수 상한 |
| `config/sources.yaml` | 출처별 하루 호출 상한, 제공처 무료 한도(`freeLimits`) |

`config/llm.yaml` 의 대화 값(모델·단가·상한)을 바꾸면 `worker/web/wrangler.toml` 의 `[vars]` 도 같은 값으로 바꾸고 화면 Worker 를 다시 배포한다(7절). 둘이 다르면 `test` 가 실패한다.

## 6. 장애 시 확인 순서

1. **화면이 열리는가**: 주소를 연다. 위쪽에 "3일 넘게 갱신되지 않았습니다"가 보이면 수집·계산이 멈춘 것이다. 하단 '자료 기준'에서 어느 출처가 멈췄는지 본다.
2. **GitHub Actions**: 실패한 워크플로의 로그를 본다. 예약 실행이 아예 없으면 `hansan-cron` 토큰 만료를 의심한다(3절).
3. **실패 기록** `data/state/failures/YYYY-MM.jsonl` 의 출처·오류 코드:
   - `INFO-100` 인증키 오류 → 키 확인·교체
   - `DG_22` 공공데이터 하루 한도 초과 / `DG_30` 미등록 키 → 다음 날 자동 재개 / 키 확인
   - `HTTP_429`·`HTTP_5xx` 한도 초과·상대 장애 → 자동 재개
   - `NET_…` 연결 실패 → 대개 일시적, 한 번 다시 시도함
   - `EMPTY`(네이버 트렌드) 검색량이 너무 적은 장소 — 정상
4. **화면 자료**: `public-data` 브랜치가 비거나 깨졌으면 `compute-daily` 를 수동 실행한다.
5. **대화가 안 됨**: `/api/chat/status` 가 `{"open":false}` 면 키 없음·하루 500회·월 $15 중 하나에 닿은 것이다. 피드는 영향 없다. `/api/stats` 에서 그날 대화 수와 월 대화 비용을 본다.
6. **주간 리포트** `docs/reports/weekly/` 의 경고(무료 한도 80%)와 실패 내역을 본다.

수집이 멈춰도 화면은 직전 자료로 동작한다(NFR-REL-01).

## 7. 처음부터 다시 배포 (NFR-MAINT-02)

필요한 것: GitHub 계정, Cloudflare 계정(무료), Node 22, 3절의 키들.

1. 저장소를 내 계정으로 복제(fork)하고 3절의 GitHub Secrets 를 넣는다.
2. `worker/cron/wrangler.toml`·`worker/web/wrangler.toml` 의 `REPO` 를 내 저장소로 바꾼다.
3. `npm ci`
4. 예약 Worker: `cd worker/cron && npx wrangler login && npx wrangler deploy && npx wrangler secret put GITHUB_TOKEN`
5. 화면 Worker: `npm run build:web && cd worker/web && npx wrangler deploy`, 이어서 `npx wrangler secret put OPENAI_API_KEY`, `npx wrangler secret put CHAT_SALT`
6. GitHub Actions 에서 `build-places-weekly` → `collect-cnctr-daily` → `collect-naver-weekly` → `collect-aux-daily` → `compute-daily` 순서로 한 번씩 수동 실행한다. 이후는 예약으로 돈다.
7. 경기 유동인구(1회성): 경기데이터드림 '유동인구_행정동 단위 집계' 최신 zip 을 받아 `data/sources/gg/` 에 풀고 `npm run import:gg` 후 커밋한다. 행정동 경계는 `npm run import:admdong`(vuski/admdongkor 최신판, `ADMDONG_VERSION=verYYYYMMDD` 로 지정 가능) 후 커밋한다.

화면만 고쳤을 때는 5번만 다시 한다. 자료는 `public-data` 브랜치에서 읽으므로 매일 재배포할 필요가 없다.

## 8. 무료 한도를 넘을 때 — 유료 전환 방법과 예상 비용

지금 운영 비용은 OpenAI 를 빼면 0원이다(NFR-COST-01). 각 서비스는 한도에 닿으면 **과금 대신 호출을 멈춘다**(NFR-COST-02). 주간 리포트가 80% 에서 경고한다. 아래 유료 가격은 2026-10 기준 확인하지 않은 값도 있으니 전환 전에 공식 가격표를 다시 본다.

| 서비스 | 무료 한도 | 넘으면 | 전환·증량 방법 | 예상 비용 |
|---|---|---|---|---|
| 공공데이터포털(TourAPI·집중률·방문자수) | 개발계정 API 별 하루 1,000건 | 그날 호출 중단, 다음 날 재개 | 활용사례 등록 후 '운영계정'으로 트래픽 증가 신청 | 무료 |
| 기상청·특일정보 | 하루 10,000건 | 위와 같음 | 위와 같음 | 무료 |
| 서울 열린데이터광장 | 미등록 키 한도 미확인, 활용사례 승인 시 제한 해제 | 호출 실패 → 직전 자료 | 열린데이터광장에서 활용사례(서비스 주소) 등록 | 무료 |
| NAVER API HUB | 검색 하루 25,000(월 775,000)·트렌드 월 50,000, 한시 무료 | 호출 실패 → 직전 자료 | 유료 전환 시 NCP 공지에 따름 | 미정(NCP 공지) |
| Cloudflare Workers(무료) | 하루 요청 100,000건, Durable Object 무료 한도 | 그날 요청 실패 | Workers Paid 로 전환 | 월 약 $5부터(공식 가격표 확인) |
| GitHub Actions | 공개 저장소 표준 러너 무료 | — | 저장소를 비공개로 바꾸면 월 무료 분량 초과분 과금 | 공개 유지 시 0 |
| OpenAI | 계정 월 예산 $20, 앱 차단선: 생성 $5 + 대화 $15 | 생성: 정형 문장, 대화: 창 닫힘(피드 정상) | `config/llm.yaml` 과 OpenAI 계정 한도를 함께 올린다 | 실측: 첫 전체 생성 약 $0.12, 이후는 같은 사실 재사용으로 그보다 적다(주간 리포트로 확인) + 대화 1건 약 $0.0002 |

## 9. 보고서

- 단계별: `docs/reports/phase1.md`, `phase2-coverage.md`(확보율), `phase5-quality.md`
- 주간 품질: `docs/reports/weekly/<주>.md` (FR-OPS-02, 매주 월요일 생성)
- 출처별 약관·한도: `docs/sources.md`

## 10. 알려진 제약

- 예측 적중률은 서울 실측이 있는 장소(32곳)만 평가할 수 있어 표본이 작다.
- 경기 유동인구는 16개 시군만 제공된다. 장소 좌표가 속한 행정동의 패턴을 쓰고(경계: 통계청 SGIS·vuski/admdongkor), 행정동 자료가 없으면 시·군·구 패턴을 쓴다. 공공누리 4유형이라 출처 '경기도'를 표시한다.
- 블로그 원문은 저장하지 않고 판정·요약에만 쓴다(재게시 조건 미확인).
- 재방문 집계(FR-OPS-07)는 개인정보 적정성 결정 전이라 하지 않는다.
