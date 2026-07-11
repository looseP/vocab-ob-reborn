# syntax=docker/dockerfile:1.7
FROM node:22.22.2-bookworm-slim AS dependencies
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts

FROM dependencies AS build
COPY . .
RUN npm run frontend:build

FROM node:22.22.2-bookworm-slim AS production-dependencies
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

FROM node:22.22.2-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
RUN mkdir -p /app /tmp/vocab-observatory && chown -R node:node /app /tmp/vocab-observatory
COPY --from=production-dependencies --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/package.json /app/package-lock.json /app/tsconfig.json ./
COPY --from=build --chown=node:node /app/src ./src
COPY --from=build --chown=node:node /app/scripts/run-review-outbox-worker.ts ./scripts/run-review-outbox-worker.ts
COPY --from=build --chown=node:node /app/scripts/run-llm-reservation-reaper.ts ./scripts/run-llm-reservation-reaper.ts
COPY --from=build --chown=node:node /app/scripts/run-backup-scheduler.ts ./scripts/run-backup-scheduler.ts
COPY --from=build --chown=node:node /app/scripts/run-data-lifecycle.ts ./scripts/run-data-lifecycle.ts
COPY --from=build --chown=node:node /app/scripts/postgres-backup.ts ./scripts/postgres-backup.ts
COPY --from=build --chown=node:node /app/dist ./dist
USER node
EXPOSE 3001
CMD ["./node_modules/.bin/tsx", "src/server.ts"]

FROM runtime AS backup-runtime
USER root
ARG POSTGRES_CLIENT_MAJOR=17
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl gnupg \
    && install -d -m 0755 /usr/share/postgresql-common/pgdg \
    && curl -fsSL https://www.postgresql.org/media/keys/ACCC4CF8.asc \
      | gpg --dearmor -o /usr/share/postgresql-common/pgdg/apt.postgresql.org.gpg \
    && echo "deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.gpg] https://apt.postgresql.org/pub/repos/apt bookworm-pgdg main" \
      > /etc/apt/sources.list.d/pgdg.list \
    && apt-get update \
    && apt-get install -y --no-install-recommends "postgresql-client-${POSTGRES_CLIENT_MAJOR}" \
    && apt-get purge -y --auto-remove curl gnupg \
    && rm -rf /var/lib/apt/lists/*
USER node
CMD ["./node_modules/.bin/tsx", "scripts/run-backup-scheduler.ts"]

FROM build AS migration
ENV NODE_ENV=production
USER node
CMD ["./node_modules/.bin/drizzle-kit", "migrate", "--config", "drizzle.config.ts"]
