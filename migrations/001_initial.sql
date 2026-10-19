-- 기획서 10장 핵심 데이터 모델.
-- GitHub ID(사용자·Repo)는 이름 변경과 이전에도 유지되므로 그대로 기본 키로 쓴다.

-- ---------------------------------------------------------------------------
-- 사용자와 인증

CREATE TABLE users (
  id             bigint PRIMARY KEY,
  login          text NOT NULL,
  name           text,
  avatar_url     text,
  is_bot         boolean NOT NULL DEFAULT false,
  -- 로그인 권한과 게임 내 카드 이용 동의는 따로 기록한다(2장).
  consent_at     timestamptz,
  -- 최초 배정이 저장된 시각. 값이 있으면 재시도해도 다시 추첨하지 않는다.
  allocated_at   timestamptz,
  tokens         integer NOT NULL DEFAULT 0 CHECK (tokens >= 0),
  cosmetics      integer NOT NULL DEFAULT 0 CHECK (cosmetics >= 0),
  normal_matches integer NOT NULL DEFAULT 0,
  created_at     timestamptz NOT NULL DEFAULT now(),
  last_login_at  timestamptz
);

-- 연습 대전 상대. GitHub 사용자 ID는 1부터 시작하므로 0과 겹치지 않는다.
INSERT INTO users (id, login, name, is_bot) VALUES (0, 'repo-tcg-bot', '연습 상대', true);

CREATE TABLE oauth_states (
  state_hash text PRIMARY KEY,
  origin     text NOT NULL,
  expires_at timestamptz NOT NULL
);

CREATE TABLE sessions (
  token_hash text PRIMARY KEY,
  user_id    bigint NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  csrf_token text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);
CREATE INDEX sessions_expires_at ON sessions (expires_at);

-- ---------------------------------------------------------------------------
-- Repo와 카드 원본

CREATE TABLE repositories (
  id             bigint PRIMARY KEY,
  owner_id       bigint NOT NULL,
  owner_login    text NOT NULL,
  owner_type     text NOT NULL,
  name           text NOT NULL,
  full_name      text NOT NULL,
  url            text NOT NULL,
  description    text,
  default_branch text NOT NULL,
  archived       boolean NOT NULL DEFAULT false,
  -- 마지막으로 받은 GitHub 응답 원본.
  metadata       jsonb NOT NULL,
  fetched_at     timestamptz NOT NULL DEFAULT now(),
  -- 연속으로 공개 접근에 실패한 횟수. 3회 이상이면 신규 발급과 분석을 멈춘다(9장).
  missing_count  integer NOT NULL DEFAULT 0,
  access_lost_at timestamptz,
  -- 운영자가 삭제 요청 등으로 숨긴 시각.
  hidden_at      timestamptz,
  hidden_reason  text
);
CREATE INDEX repositories_owner ON repositories (owner_id);

-- 최초 배정 결과. position은 서버에서 섞은 순서이다.
CREATE TABLE allocations (
  user_id  bigint NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  repo_id  bigint NOT NULL REFERENCES repositories (id),
  position integer NOT NULL,
  bucket   text NOT NULL CHECK (bucket IN ('initial', 'personal', 'public')),
  PRIMARY KEY (user_id, repo_id),
  UNIQUE (user_id, position)
);

CREATE TABLE seasons (
  id           integer PRIMARY KEY,
  status       text NOT NULL CHECK (status IN ('preparing', 'active', 'retired')),
  created_at   timestamptz NOT NULL DEFAULT now(),
  activated_at timestamptz
);
CREATE UNIQUE INDEX seasons_one_active ON seasons (status) WHERE status = 'active';
CREATE UNIQUE INDEX seasons_one_preparing ON seasons (status) WHERE status = 'preparing';
INSERT INTO seasons (id, status, activated_at) VALUES (1, 'active', now());

-- 시즌별 카드 버전. 경기는 시작할 때 card 값을 복사해 고정한다.
CREATE TABLE card_versions (
  repo_id        bigint NOT NULL REFERENCES repositories (id),
  season_id      integer NOT NULL REFERENCES seasons (id),
  status         text NOT NULL CHECK (status IN ('ready', 'pending', 'error')),
  card           jsonb,
  grade          jsonb,
  classification jsonb,
  -- 분류 입력(README·토픽·파일 구조 등)의 해시. 같으면 AI를 다시 부르지 않는다.
  input_hash     text,
  rules_version  text,
  reason         text,
  updated_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (repo_id, season_id)
);

-- ---------------------------------------------------------------------------
-- 공용 풀과 보유 카드

CREATE TABLE pool_memberships (
  repo_id    bigint NOT NULL REFERENCES repositories (id),
  -- general, theme:<이름>, event:<이름>
  pool       text NOT NULL CHECK (pool ~ '^(general|theme:[a-z0-9-]+|event:[a-z0-9-]+)$'),
  active     boolean NOT NULL DEFAULT false,
  weight     integer NOT NULL DEFAULT 1 CHECK (weight BETWEEN 1 AND 100),
  source     text NOT NULL CHECK (source IN ('owner_overflow', 'admin', 'admin_org', 'seed')),
  added_by   bigint,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (repo_id, pool)
);

CREATE TABLE user_cards (
  user_id    bigint NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  repo_id    bigint NOT NULL REFERENCES repositories (id),
  -- initial, starter_pool, tutorial, matches:3, discovery 등 획득 경로.
  source     text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, repo_id)
);

CREATE TABLE decks (
  user_id    bigint PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
  repo_ids   bigint[] NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- 작업 큐. key가 같으면 같은 작업이라 중복 등록되지 않는다.

CREATE TABLE jobs (
  id           bigserial PRIMARY KEY,
  kind         text NOT NULL,
  key          text NOT NULL UNIQUE,
  payload      jsonb NOT NULL,
  status       text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'done', 'error')),
  attempts     integer NOT NULL DEFAULT 0,
  max_attempts integer NOT NULL DEFAULT 5,
  available_at timestamptz NOT NULL DEFAULT now(),
  locked_at    timestamptz,
  last_error   text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX jobs_claimable ON jobs (available_at) WHERE status = 'queued';
CREATE INDEX jobs_running ON jobs (locked_at) WHERE status = 'running';

-- ---------------------------------------------------------------------------
-- 대전

CREATE TABLE matches (
  id         uuid PRIMARY KEY,
  mode       text NOT NULL CHECK (mode IN ('pvp', 'bot')),
  season_id  integer NOT NULL REFERENCES seasons (id),
  player0    bigint NOT NULL REFERENCES users (id),
  player1    bigint NOT NULL REFERENCES users (id),
  deck0      text NOT NULL CHECK (deck0 IN ('owned', 'trial')),
  deck1      text NOT NULL CHECK (deck1 IN ('owned', 'trial')),
  -- 엔진 상태 전체(난수 상태와 상대 손패 포함). 클라이언트에 그대로 보내지 않는다.
  state      jsonb NOT NULL,
  seq        integer NOT NULL,
  -- 현재 턴(또는 교환 단계)의 마감 시각.
  deadline   timestamptz NOT NULL,
  -- 배포·공격·폐기 같은 실제 행동 수. 정상 대전 판정에 쓴다(8장).
  acted0     integer NOT NULL DEFAULT 0,
  acted1     integer NOT NULL DEFAULT 0,
  -- 연속 무행동 턴 수. 2가 되면 패배 처리한다(7장).
  idle0      integer NOT NULL DEFAULT 0,
  idle1      integer NOT NULL DEFAULT 0,
  -- 현재 턴에 턴 주인이 명령을 보냈는지.
  turn_acted boolean NOT NULL DEFAULT false,
  result     jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  ended_at   timestamptz,
  settled_at timestamptz,
  CHECK (player0 <> player1)
);
CREATE INDEX matches_open_player0 ON matches (player0) WHERE ended_at IS NULL;
CREATE INDEX matches_open_player1 ON matches (player1) WHERE ended_at IS NULL;
CREATE INDEX matches_open_deadline ON matches (deadline) WHERE ended_at IS NULL;

-- 같은 commandId의 재전송에는 저장된 응답을 그대로 돌려준다.
CREATE TABLE match_commands (
  match_id   uuid NOT NULL REFERENCES matches (id) ON DELETE CASCADE,
  user_id    bigint NOT NULL REFERENCES users (id),
  command_id uuid NOT NULL,
  response   jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (match_id, user_id, command_id)
);

CREATE TABLE queue_entries (
  user_id   bigint PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
  deck_kind text NOT NULL CHECK (deck_kind IN ('owned', 'trial')),
  created_at timestamptz NOT NULL DEFAULT now(),
  -- 대기 화면이 마지막으로 확인한 시각. 오래되면 매칭에서 뺀다.
  seen_at   timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- 보상

-- 모든 지급에 고유 키를 둔다. 같은 키는 한 번만 들어간다.
CREATE TABLE reward_grants (
  user_id    bigint NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  grant_key  text NOT NULL,
  kind       text NOT NULL CHECK (kind IN ('card', 'token', 'cosmetic')),
  repo_id    bigint REFERENCES repositories (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, grant_key)
);

-- 동일 상대와의 정상 대전 인정 횟수(하루 3회 상한).
CREATE TABLE opponent_days (
  user_id     bigint NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  opponent_id bigint NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  day         date NOT NULL,
  count       integer NOT NULL,
  PRIMARY KEY (user_id, opponent_id, day)
);

CREATE TABLE discoveries (
  id         bigserial PRIMARY KEY,
  user_id    bigint NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  options    bigint[] NOT NULL CHECK (cardinality(options) BETWEEN 1 AND 3),
  chosen     bigint,
  created_at timestamptz NOT NULL DEFAULT now(),
  chosen_at  timestamptz,
  CHECK (chosen IS NULL OR chosen = ANY (options))
);
-- 선택을 끝내기 전에는 새 발견을 열 수 없다.
CREATE UNIQUE INDEX discoveries_one_open ON discoveries (user_id) WHERE chosen IS NULL;
