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
COPY --from=production-dependencies --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/package.json /app/package-lock.json /app/tsconfig.json ./
COPY --from=build --chown=node:node /app/src ./src
COPY --from=build --chown=node:node /app/scripts/run-review-outbox-worker.ts ./scripts/run-review-outbox-worker.ts
COPY --from=build --chown=node:node /app/scripts/run-llm-reservation-reaper.ts ./scripts/run-llm-reservation-reaper.ts
COPY --from=build --chown=node:node /app/dist ./dist
USER node
EXPOSE 3001
CMD ["./node_modules/.bin/tsx", "src/server.ts"]

FROM build AS migration
ENV NODE_ENV=production
USER node
CMD ["./node_modules/.bin/drizzle-kit", "migrate", "--config", "drizzle.config.ts"]
