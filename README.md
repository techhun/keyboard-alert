# keyboard-alert

키보드 관련 매물·커뮤니티·공제·생산 일정의 변경을 수집해 Discord(및 일부 ntfy)로 알리는 개인용 GitHub Actions 프로젝트입니다.

## 감시 대상

| 소스 | 감시 내용 | 알림 기준 | 상태 파일 |
| --- | --- | --- | --- |
| Guheyo | 키보드 장터 `판매 → 키캡` | **신규 판매글 URL만** 알림. 기존 글의 제목·가격·본문 수정은 감지하지 않음 | `guheyo-state.json` |
| DCInside | 기계식키보드 갤러리 `⚡떴냐` 탭 | 기준 글 번호보다 새 글 | `dcinside-tteotnya-state.json` |
| GEONWORKS GB | GB Schedule | 신규/변경/목록 제거 | `geonworks-state.json` |
| GEONWORKS Release | Release Schedule | 신규/변경/목록 제거 | `geonworks-release-state.json` |
| ProtoTypist | Keyboard / GMK / Keyset 진행 보드 | 신규/상태·배송예정 변경/목록 제거 | `prototypist-state.json` |
| SWAGKEYS | 분기별 Keycap Roadmap + Keycap Status | 공지, 분기 이동·신규 배치·로드맵 제외, 진행상황 변경 | `swagkeys-state.json` |
| Oblotzky Industries | Schedule | 신규/Last Updated·Status 변경/목록 제거 | `oblotzky-state.json` |
| NovelKeys | Product Updates | 신규/Current Status·Estimated Arrival 변경/목록 제거 | `novelkeys-state.json` |
| KBDfans | Product Updates | 신규/상태·ETA·진행률·최신 업데이트 변경/목록 제거 | `kbdfans-state.json` |
| CannonKeys | Project Updates | 신규/상태·ETA·GB 일정·최신 업데이트 변경/목록 제거 | `cannonkeys-state.json` |

## 실행 구조

외부 스케줄러는 **cron-job.org**를 사용합니다. GitHub Actions 자체의 `schedule:` 트리거는 사용하지 않습니다.

### Fast

`.github/workflows/keyboard-alert-fast.yml`

- Guheyo
- DCInside `⚡떴냐`
- 실행 주기: **1분**
- concurrency: `keyboard-alerts-fast`

### Slow

`.github/workflows/keyboard-alert-slow.yml`

- GEONWORKS GB
- GEONWORKS Release
- ProtoTypist
- SWAGKEYS
- Oblotzky Industries
- NovelKeys
- KBDfans
- CannonKeys
- 실행 주기: **10분**
- concurrency: `keyboard-alerts-slow`

변경 빈도가 낮고 Notion 등 외부 페이지의 응답이 느릴 수 있는 감시원을 fast workflow와 분리해, 느린 소스가 Guheyo/DCInside 알림을 지연시키지 않도록 구성합니다.

## 시스템 상태 알림

별도 Discord 채널(권장 이름: `알림-시스템`)로 감시 서비스 자체의 장애와 복구를 알릴 수 있습니다.

- 각 소스가 재시도 후에도 실패하면 **오류 전환 시 1회만** 알림
- 같은 장애가 계속되는 동안에는 반복 알림을 보내지 않음
- 이후 정상 수집이 확인되면 **복구 알림 1회** 전송
- GitHub Actions의 state 저장 등 workflow 자체가 실패하면 별도 workflow 오류 알림 전송
- 오류가 발생한 실행의 GitHub Actions 링크를 Discord 알림 제목에 연결

상태는 Fast/Slow로 분리해 저장합니다.

- `system-health-fast.json`
- `system-health-slow.json`

## 실행 명령

```bash
npm run check:guheyo
npm run check:dcinside
npm run check:geonworks
npm run check:geonworks-release
npm run check:prototypist
npm run check:swagkeys
npm run check:oblotzky
npm run check:novelkeys
npm run check:kbdfans
npm run check:cannonkeys
npm run system:health -- ...
```

의존성은 `package-lock.json`으로 고정하며 GitHub Actions에서는 `npm ci`를 사용합니다. Playwright는 현재 `1.55.0`으로 고정되어 있습니다.

## 알림 Secret

GitHub 저장소의 **Settings → Secrets and variables → Actions**에서 관리합니다.

| Secret | 용도 |
| --- | --- |
| `GUHEYO_DISCORD_WEBHOOK_URL` | Guheyo Discord 알림. 미설정 시 기존 `DISCORD_WEBHOOK_URL`을 fallback으로 사용 |
| `GUHEYO_NTFY_TOPIC` | Guheyo ntfy 알림. 미설정 시 기존 `NTFY_TOPIC`을 fallback으로 사용 |
| `DCINSIDE_DISCORD_WEBHOOK_URL` | 기키갤 `⚡떴냐` 전용 Discord 알림 |
| `GEONWORKS_DISCORD_WEBHOOK_URL` | GEONWORKS GB / Release 알림 |
| `PROTOTYPIST_DISCORD_WEBHOOK_URL` | ProtoTypist 알림 |
| `SWAGKEYS_DISCORD_WEBHOOK_URL` | SWAGKEYS 알림. 미설정 시 기존 `SWG_DISCORD_WEBHOOK_URL`을 fallback으로 사용 |
| `OBLOTZKY_DISCORD_WEBHOOK_URL` | Oblotzky Industries Schedule 알림 |
| `NOVELKEYS_DISCORD_WEBHOOK_URL` | NovelKeys Product Updates 알림 |
| `KBDFANS_DISCORD_WEBHOOK_URL` | KBDfans Product Updates 알림 |
| `CANNONKEYS_DISCORD_WEBHOOK_URL` | CannonKeys Project Updates 알림 |
| `SYSTEM_DISCORD_WEBHOOK_URL` | `알림-시스템` 채널의 장애/복구/워크플로 오류 알림 |

각 서비스의 webhook은 서로 분리해 운용하는 것을 기본으로 합니다.

## 상태 저장 원칙

- 최초 실행은 현재 데이터를 baseline으로 저장하고 과거 항목을 알리지 않습니다.
- 알림을 보내야 하는 변경이 있는데 해당 알림 채널이 설정되지 않았거나 전송에 실패하면 가능한 범위에서 state를 넘기지 않아 다음 실행에서 다시 처리합니다.
- Guheyo는 신규 글만 감시하며, 이미 본 URL의 수정은 의도적으로 무시합니다.
- DCInside는 `search_head=110` 필터와 각 행의 `⚡떴냐` 카테고리를 함께 검증합니다.
- GEONWORKS / ProtoTypist / SWAGKEYS / Oblotzky / NovelKeys / KBDfans / CannonKeys에서 기존 항목의 **목록 제거**가 감지되면 해당 소스를 즉시 한 번 더 읽고, 두 번 연속 같은 제거가 확인될 때만 제거 알림과 state 갱신을 수행합니다.
- 두 번째 확인에서 항목이 다시 나타나거나 제거 목록이 달라지면 해당 제거를 확정하지 않아 일시적인 부분 로딩을 삭제로 오인하지 않습니다.
- SWAGKEYS는 Notion의 `Loading`, `No results`, 오류 placeholder 등을 정상 제품으로 저장하지 않으며, 상태표를 일시적으로 읽지 못하면 마지막 검증된 상태를 재사용합니다.
- system health는 정상→오류, 오류→정상처럼 상태가 바뀔 때만 Discord 알림을 보내 중복 장애 알림을 막습니다.
- workflow의 state push는 `git pull --rebase` + `git push`를 재시도해 fast/slow 동시 실행 시 충돌 가능성을 줄입니다.

## 주요 스크립트

```text
scripts/
├─ check-guheyo.mjs
├─ check-dcinside.mjs
├─ check-geonworks.mjs
├─ check-geonworks-release.mjs
├─ check-prototypist.mjs
├─ check-swagkeys.mjs
├─ check-oblotzky.mjs
├─ check-novelkeys.mjs
├─ check-kbdfans.mjs
├─ check-cannonkeys.mjs
└─ system-health.mjs
```

각 스크립트 이름과 상태 파일 이름은 감시 소스 기준으로 통일되어 있습니다.

## 수동 실행

GitHub의 **Actions** 탭에서 다음 workflow를 직접 실행할 수 있습니다.

- `Keyboard alerts (fast)`
- `Keyboard alerts (slow)`

테스트용 알림이 필요한 경우 production state를 변경하지 않는 별도 one-shot workflow를 사용하고, 테스트 후 제거하는 방식을 권장합니다.

## cron-job.org 설정

- Fast: `keyboard-alert-fast.yml` → 1분 간격
- Slow: `keyboard-alert-slow.yml` → 10분 간격

두 cron job 모두 `POST`로 GitHub `workflow_dispatch` endpoint를 호출하고 request body는 `{"ref":"main"}`을 사용합니다.
