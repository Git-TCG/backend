#!/bin/sh
# Docker만으로 타입 검사와 전체 테스트(PostgreSQL 연동 포함)를 실행한다.
# 사용법: scripts/test-docker.sh [vitest 인자...]
set -eu

cd "$(dirname "$0")/.."
NET="tcg-test-$$"
DB="tcg-test-db-$$"

cleanup() {
  docker rm -f "$DB" >/dev/null 2>&1 || true
  docker network rm "$NET" >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM

docker network create "$NET" >/dev/null
docker run -d --name "$DB" --network "$NET" \
  -e POSTGRES_USER=tcg -e POSTGRES_PASSWORD=tcg -e POSTGRES_DB=tcg postgres:16 >/dev/null
until docker exec "$DB" pg_isready -U tcg -d tcg >/dev/null 2>&1; do sleep 1; done
# pg_isready는 초기화 중 임시 서버에도 응답하므로 실제 접속이 될 때까지 한 번 더 기다린다.
until docker exec "$DB" psql -U tcg -d tcg -c 'select 1' >/dev/null 2>&1; do sleep 1; done

docker run --rm --network "$NET" \
  -u "$(id -u):$(id -g)" -e HOME=/tmp \
  -e TEST_DATABASE_URL="postgres://tcg:tcg@$DB:5432/tcg" \
  -v "$PWD":/app -w /app node:24-alpine \
  sh -c 'npm ci --no-fund --no-audit --loglevel=error && npx tsc --noEmit && npx vitest run "$@"' -- "$@"
