# syntax=docker/dockerfile:1
FROM node:24-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM deps AS build
COPY tsconfig.json tsconfig.build.json ./
COPY migrations ./migrations
COPY src ./src
# PostgreSQL 연동 테스트는 TEST_DATABASE_URL이 없으면 건너뛴다. 전체 테스트는 scripts/test-docker.sh로 실행한다.
RUN npm run typecheck && npm test && npm run build

FROM node:24-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY migrations ./migrations
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s \
  CMD wget -qO- http://127.0.0.1:3000/health >/dev/null || exit 1
CMD ["node", "dist/index.js"]
