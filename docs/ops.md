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
| collect-seoul-hourly | 매시 17분 (Cloudflare Worker `hansan-cron` 이 실행, GitHub 예약은 보조. 같은 시간대 중복 실행은 건너뜀, 강제 수집은 `FORCE=1`) | 서울 121곳 실시간 인구 → `data/raw/seoul_citydata/YYYY-MM/DD.jsonl`, 장소별 최신값 `data/latest/seoul_citydata.json` |
| collect-naver-weekly | 월 03:23 | 장소별 블로그 게시글 수·최근 게시일 → `data/raw/naver_blog/`, 검색어 트렌드(기준 키워드 대비 비율, 첫 회 2016년부터 월 단위 백필) → `data/raw/naver_trend/`. 장소 목록(`data/places/places.json`)이 없으면 건너뜀. 블로그 제목·요약은 저장하지 않음 |
| test | push 시 | 타입 검사, 자동 시험 |

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

## 장애 시 확인 순서

1. Actions 탭에서 실패한 실행의 로그를 본다 (실패하면 GitHub 이 저장소 소유자에게 메일을 보낸다)
2. `data/state/failures/YYYY-MM.jsonl` 에서 출처·장소·오류 코드를 본다
   - `INFO-100`: 인증키 오류 → 비밀 값 확인
   - `AREA_MISMATCH`: 샘플 키가 들어가 있음 → 실제 인증키로 교체
3. 수집이 멈춰도 화면은 `data/latest/` 의 직전 값으로 동작한다
