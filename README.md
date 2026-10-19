# Repo TCG 실행

루트 `README.md`는 게임 기획서입니다. 이 디렉터리는 API, 작업 워커, PostgreSQL, 웹 Docker 구성을 담습니다.

## 시작

1. `backend/.env`가 없을 때만 `.env.example`을 `.env`로 복사합니다. 기존 `.env`는 덮어쓰지 않습니다.
2. GitHub OAuth 앱에 `http://localhost:8123/api/auth/github`, `http://192.168.0.33:8123/api/auth/github`을 콜백으로 등록하고 `.env`에 클라이언트 ID·시크릿을 설정합니다. `CORS_ORIGINS`에는 접속할 웹 호스트 또는 전체 Origin을 쉼표로 나열합니다. 운영자 기능은 숫자 GitHub 사용자 ID를 `ADMIN_GITHUB_IDS`에 지정해야 열립니다.
3. `docker compose up --build -d`를 이 디렉터리에서 실행하고 `http://localhost:8123` 또는 LAN 주소 `http://192.168.0.33:8123`으로 접속합니다. DB 마이그레이션이 완료된 뒤 API와 워커가 시작됩니다. 건강 확인은 `/api/health`입니다.

`GITHUB_CLASSIC_TOKEN`은 공개 Repo 조회에 사용합니다. 사용자 OAuth 토큰은 로그인 시 사용자 확인에만 쓰고 DB에 저장하지 않습니다. `OPENAI_API_KEY`를 비우면 범용 분류를 사용합니다. 실제 Repo 등급은 필수 GitHub 지표가 모두 수집될 때만 발행합니다.

## 공용 카드 준비

공용 후보 20개는 `content/starter-repos.txt`에 있습니다. 운영자가 목록을 검토·수정한 다음 다음 명령으로 등록합니다.

```sh
docker compose run --rm api node dist/cli/seed.js content/starter-repos.txt
```

작업 워커의 분석이 끝나면 관리자 화면에서 **준비됨** 상태를 확인하고 게시합니다. 20장이 준비되지 않으면 목록을 보충한 뒤 같은 명령을 다시 실행합니다. 게시 전에는 공용 카드로 지급하지 않습니다. 공용 카드가 7장 미만이면 자신의 유효 Repo가 부족한 신규 사용자의 실제 카드 시작 덱이 완료되지 않습니다. 가상 체험 덱은 별도로 대전할 수 있으며 실제 Repo 카드로 표시하지 않습니다.

## 사용 흐름

GitHub 로그인 후 카드 이용 동의 → 최초 수집과 분석 상태 확인 → 7장 덱 저장 또는 체험 덱 선택 → 대기열 → 1대1 대전입니다. 대전은 3초 간격으로 서버 상태를 갱신하며 재접속해도 진행 중인 경기를 복구합니다. 45초가 지나면 서버가 턴을 처리합니다. 발견 후보는 선택 전까지 보존됩니다. `새 Repo 동기화`는 하루 한 번 새 작업을 등록합니다.

관리자 화면에서 공개 Repo를 등록·분석·게시하고, 다음 시즌 준비 작업이 모두 끝났을 때 시즌을 게시할 수 있습니다. 진행 중인 경기는 시작 당시 카드 수치를 보관합니다.

## 검증

```sh
npm ci
npm run typecheck
npm test
npm run build
```

`TEST_DATABASE_URL=postgres://... npm test`를 사용하면 PostgreSQL 연동 테스트도 실행됩니다. 공개 GitHub와 실제 OAuth 브라우저 왕복은 계정·앱 설정이 있어야 확인할 수 있습니다.
