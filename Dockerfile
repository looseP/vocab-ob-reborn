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
RUN mkdir -p /app /backups /tmp/vocab-observatory && chown -R node:node /app /backups /tmp/vocab-observatory
COPY --from=production-dependencies --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/package.json /app/package-lock.json /app/tsconfig.json ./
COPY --from=build --chown=node:node /app/src ./src
COPY --from=build --chown=node:node /app/scripts/run-review-outbox-worker.ts ./scripts/run-review-outbox-worker.ts
COPY --from=build --chown=node:node /app/scripts/run-llm-reservation-reaper.ts ./scripts/run-llm-reservation-reaper.ts
COPY --from=build --chown=node:node /app/scripts/run-backup-scheduler.ts ./scripts/run-backup-scheduler.ts
COPY --from=build --chown=node:node /app/scripts/run-data-lifecycle.ts ./scripts/run-data-lifecycle.ts
COPY --from=build --chown=node:node /app/scripts/postgres-backup.ts ./scripts/postgres-backup.ts
COPY --from=build --chown=node:node /app/scripts/verify-release-database.ts ./scripts/verify-release-database.ts
COPY --from=build --chown=node:node /app/dist ./dist
USER node
EXPOSE 3001
CMD ["./node_modules/.bin/tsx", "src/server.ts"]

FROM postgres:17.10-bookworm@sha256:4f736ae292687621d4dbe0d499ffd024a36bd2ee7d8ca6f2ccd4c800f047b394 AS postgres-backup-client
RUN set -eu; \
    client_root=/postgres-client-root; \
    client_dir="${client_root}/opt/postgres-client"; \
    provenance="${client_dir}/provenance.tsv"; \
    mkdir -p "${client_dir}/bin" "${client_dir}/lib" "${client_root}/usr/local/bin"; \
    printf 'meta\tschemaVersion\t1\nmeta\tsourceImageDigest\tsha256:4f736ae292687621d4dbe0d499ffd024a36bd2ee7d8ca6f2ccd4c800f047b394\n' > "${provenance}"; \
    record_file() { \
      source_file="$1"; \
      destination_file="$2"; \
      resolved_source="$(readlink -f "${source_file}")"; \
      owner="$(dpkg-query -S "${source_file}" 2>/dev/null | awk -F: 'NR == 1 { print $1 }' || true)"; \
      if [ -z "${owner}" ]; then owner="$(dpkg-query -S "${resolved_source}" 2>/dev/null | awk -F: 'NR == 1 { print $1 }' || true)"; fi; \
      test -n "${owner}"; \
      version="$(dpkg-query -W -f='${Version}' "${owner}")"; \
      architecture="$(dpkg-query -W -f='${Architecture}' "${owner}")"; \
      source_package="$(dpkg-query -W -f='${source:Package}' "${owner}")"; \
      test -n "${version}" && test -n "${architecture}"; \
      test -n "${source_package}" || source_package="${owner}"; \
      printf 'file\t%s\t%s\t%s\t%s\t%s\n' "${destination_file}" "${owner}" "${version}" "${architecture}" "${source_package}" >> "${provenance}"; \
    }; \
    : > /tmp/postgres-client-libraries.raw; \
    for name in pg_dump pg_restore; do \
      binary="/usr/lib/postgresql/17/bin/${name}"; \
      version="$(${binary} --version | awk 'NR == 1 && $2 == "(PostgreSQL)" { print $3 }')"; \
      test "${version}" = "17.10"; \
      printf 'tool\t%s\t%s\n' "${name}" "${version}" >> "${provenance}"; \
      cp "${binary}" "${client_dir}/bin/${name}.real"; \
      record_file "${binary}" "/opt/postgres-client/bin/${name}.real"; \
      ldd "${binary}" | awk '$2 == "=>" && $3 ~ /^\// { print $3 } $1 ~ /^\// { print $1 }' >> /tmp/postgres-client-libraries.raw; \
    done; \
    sort -u /tmp/postgres-client-libraries.raw > /tmp/postgres-client-libraries; \
    while IFS= read -r library; do \
      destination="${client_dir}/lib/$(basename "${library}")"; \
      cp -L "${library}" "${destination}"; \
      record_file "${library}" "/opt/postgres-client/lib/$(basename "${library}")"; \
    done < /tmp/postgres-client-libraries; \
    loader="$(ldd /usr/lib/postgresql/17/bin/pg_dump | awk '$1 ~ /^\// { print $1; exit }')"; \
    loader_name="$(basename "${loader}")"; \
    test -x "${client_dir}/lib/${loader_name}"; \
    for name in pg_dump pg_restore; do \
      printf '#!/bin/sh\nexec "/opt/postgres-client/lib/%s" --library-path "/opt/postgres-client/lib" "/opt/postgres-client/bin/%s.real" "$@"\n' \
        "${loader_name}" "${name}" > "${client_root}/usr/local/bin/${name}"; \
      chmod 0755 "${client_root}/usr/local/bin/${name}"; \
      "${client_dir}/lib/${loader_name}" --library-path "${client_dir}/lib" "${client_dir}/bin/${name}.real" --version; \
    done; \
    test ! -e "${client_dir}/bin/postgres"; \
    test ! -e "${client_dir}/bin/psql"; \
    grep -q '/opt/postgres-client/bin/pg_dump.real' "${provenance}"; \
    grep -q '/opt/postgres-client/bin/pg_restore.real' "${provenance}"

FROM scratch AS backup-runtime
ENV NODE_ENV=production
ENV PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
WORKDIR /app
COPY --from=runtime / /
COPY --from=postgres-backup-client /postgres-client-root/ /
RUN node --version \
    && npm --version \
    && pg_dump --version \
    && pg_restore --version \
    && test ! -e /opt/postgres-client/bin/postgres \
    && test ! -e /opt/postgres-client/bin/psql
USER node
CMD ["./node_modules/.bin/tsx", "scripts/run-backup-scheduler.ts"]

FROM build AS migration
ENV NODE_ENV=production
USER node
CMD ["./node_modules/.bin/drizzle-kit", "migrate", "--config", "drizzle.config.ts"]
