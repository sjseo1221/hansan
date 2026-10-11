# 운영 문서 (초안 — 6단계에서 완성)

## 비밀 값

저장소 Settings > Secrets and variables > Actions 에 둔다. 저장소·로그·채팅에 쓰지 않는다.

| 이름 | 용도 |
|---|---|
| SEOUL_OPENAPI_KEY | 서울 열린데이터광장 실시간 인구 |
| DATA_GO_KR_KEY | 공공데이터포털 (관광공사·TourAPI·기상청·특일정보) |
| NAVER_CLIENT_ID, NAVER_CLIENT_SECRET | NAVER API HUB |
| OPENAI_API_KEY | 근거 생성·대화 |

키 교체: 같은 이름으로 새 값을 저장하면 다음 실행부터 적용된다.

## 주기 작업

| 워크플로 | 시각(KST) | 내용 |
|---|---|---|
| collect-seoul-hourly | 매시 17분 (Cloudflare Worker `hansan-cron` 이 실행, GitHub 예약은 보조. 같은 시간대에 이미 '시도'했으면 성공 여부와 무관하게 건너뜀 — 강제 재수집은 `FORCE=1`) | 서울 121곳 실시간 인구 → `data/raw/seoul_citydata/YYYY-MM/DD.jsonl`, 장소별 최신값 `data/latest/seoul_citydata.json` |
| collect-cnctr-daily | 매일 04:30 | 관광지 집중률 30일 예측(시·군·구 단위) → 최신 `data/latest/cnctr.json`(덮어씀), 오늘 날짜 값만 `data/raw/cnctr_history/` 누적, 관광지 이름 목록 `data/sources/cnctr/attractions.json`. 응답 없는 시·군·구 코드는 비활성으로 기록하고 월요일에 다시 확인 |
| build-places-weekly | 월 04:50 | TourAPI 시·군·구 목록·후보 → 집중률 관광지와 이름 매칭 → `data/places/places.json`, 지표 `data/places/report.json`. 보이는 장소가 직전보다 30% 넘게 줄면 목록을 바꾸지 않고 실패 |
| collect-naver-weekly | 매일 05:23 (장소를 요일별 7묶음으로 나눠 장소마다 주 1회) | 장소별 블로그 게시글 수·최근 게시일 → `data/raw/naver_blog/`, 검색어 트렌드(기준 키워드 대비 비율, 첫 회 2016년부터 월 단위 백필) → `data/raw/naver_trend/`. 장소 목록(`data/places/places.json`)이 없으면 건너뜀. 블로그 제목·요약은 저장하지 않음 |
| test | push 시 | 타입 검사, 자동 시험 |

## 장소 추가·숨김·수정 (FR-OPS-05)

`data/places/places.json` 은 매주 다시 만드는 생성 파일이라 직접 고치지 않는다. **`data/places/overrides.yaml` 만 고친다.**

- 숨김: `places.<placeId>.hidden: true` — 다음 주기 작업부터 추천·수집에서 빠진다(FR-DATA-13)
- 이름·분류·실내외·네이버 검색어 보정: `places.<placeId>` 아래 같은 이름의 값
- 자동 매칭 실패·오매칭 교정: `matches` 에 `{ signguCd, tAtsNm, contentId }` (`contentId: null` 이면 연결 차단). 수동 매칭 대상은 `report.json` 의 `unmatched.list`
- 집중률에 없는 장소 추가: `add` (SRS 9절 필드 전부)

고친 뒤 커밋하면 다음 `build-places-weekly` 에 반영된다. 바로 반영하려면 Actions 에서 수동 실행한다.

## 설정 파일 (기준값 변경)

값을 바꾸고 커밋하면 다음 주기 작업부터 적용된다. push 하면 `test` 워크플로가 파일끼리 어긋나지 않는지 검사한다.

| 파일 | 내용 |
|---|---|
| `config/thresholds.yaml` | 유형 판정 기준값, 대표 유형 순서, 한산 가능성 구간, 피드 표시 수, 인기도 가중치 |
| `config/categories.yaml` | 장소 분류 8종, 서울 장소 카테고리 → 분류 연결 |
| `config/companions.yaml` | 동행 유형 5종 × 분류 적합 표 |
| `config/regions.yaml` | 대상 시·도, 이동 시간 어림 계수 |
| `config/llm.yaml` | OpenAI 모델·월 예산·대화 상한 |
| `config/sources.yaml` | 출처별 하루 호출 상한 |

## 호출 상한

`config/sources.yaml` 의 `dailyCap` 이 출처별 하루 상한이다. 닿으면 남은 장소는 다음 실행으로 넘어간다. 하루 사용량은 `data/state/usage/<출처>/<날짜>.json`.

## 알려진 위험과 수용

- **서울 인증키 평문 전송**: 서울 열린데이터광장 API 는 http(8088) 만 지원한다(2026-10-11 실호출 확인). 키가 URL 경로로 암호화 없이 전송된다. 이 키는 다른 곳에 재사용하지 않고, 유출이 의심되면 즉시 재발급해 `SEOUL_OPENAPI_KEY` 를 교체한다. 무과금 키라 금전 피해는 없다.
- **Cron 트리거 토큰 만료**: Cloudflare Worker `hansan-cron` 은 GitHub fine-grained token(`hansan` 전용, Actions 읽기·쓰기)으로 워크플로를 실행한다. 만료일 전에 새 토큰을 만들어 `worker/cron` 에서 `npx wrangler secret put GITHUB_TOKEN` 으로 교체한다. 만료되면 GitHub 예약 실행만 남는데, 예약은 지연·누락이 잦다.
- **저장소 용량**: 수집 결과를 매시간 커밋한다. 2단계 전에 월 단위 정리 방침을 정한다.

## 종료 코드와 알림

수집 작업은 아래면 실패(종료 코드 1)로 끝나 GitHub 이 메일로 알린다: 하루 상한이 이미 소진돼 한 건도 못 했을 때, 연속 10회 실패로 중단했을 때, 실패율이 50% 를 넘었을 때, 장소 목록이 비었을 때. 네이버는 블로그·트렌드를 따로 판정한다.

## 장애 시 확인 순서

1. Actions 탭에서 실패한 실행의 로그를 본다 (실패하면 GitHub 이 저장소 소유자에게 메일을 보낸다)
2. `data/state/failures/YYYY-MM.jsonl` 에서 출처·장소·오류 코드를 본다
   - `INFO-100`: 인증키 오류 → 비밀 값 확인
   - `AREA_MISMATCH`: 샘플 키가 들어가 있음 → 실제 인증키로 교체
   - `HTTP_429`·`HTTP_5xx`: 호출 한도 초과·상대 서버 장애 → 다음 날 또는 복구 후 자동 재개
   - `EMPTY`·`EMPTY_ANCHOR`(네이버 트렌드): 빈 응답 — 백필 완료로 표시하지 않으므로 다음 실행에서 다시 받는다
3. 수집이 멈춰도 화면은 `data/latest/` 의 직전 값으로 동작한다
