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
| collect-seoul-hourly | 매시 17분 | 서울 121곳 실시간 인구 → `data/raw/seoul_citydata/YYYY-MM/DD.jsonl`, 장소별 최신값 `data/latest/seoul_citydata.json` |
| test | push 시 | 타입 검사, 자동 시험 |

## 호출 상한

`config/sources.yaml` 의 `dailyCap` 이 출처별 하루 상한이다. 닿으면 남은 장소는 다음 실행으로 넘어간다. 하루 사용량은 `data/state/usage/<출처>/<날짜>.json`.

## 장애 시 확인 순서

1. Actions 탭에서 실패한 실행의 로그를 본다 (실패하면 GitHub 이 저장소 소유자에게 메일을 보낸다)
2. `data/state/failures/YYYY-MM.jsonl` 에서 출처·장소·오류 코드를 본다
   - `INFO-100`: 인증키 오류 → 비밀 값 확인
   - `AREA_MISMATCH`: 샘플 키가 들어가 있음 → 실제 인증키로 교체
3. 수집이 멈춰도 화면은 `data/latest/` 의 직전 값으로 동작한다
