FROM node:24.21.0-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY backend/package.json backend/package.json
COPY frontend/package.json frontend/package.json
RUN npm ci --no-audit --no-fund
COPY frontend frontend
RUN npm run build
RUN npm prune --omit=dev --no-audit --no-fund

FROM node:24.21.0-bookworm-slim AS harness
RUN apt-get update && apt-get install -y --no-install-recommends build-essential && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
COPY backend/package.json backend/package.json
COPY frontend/package.json frontend/package.json
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY scripts/build-legal-harness.mjs scripts/build-legal-harness.mjs
COPY runtime/legal-harness runtime/legal-harness
ENV LEGAL_HARNESS_ROOT=/opt/legal-harness
RUN npm run harness:build

FROM postgres:18-bookworm AS runtime
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates libstdc++6 fonts-noto-cjk && rm -rf /var/lib/apt/lists/* && useradd -m -u 1000 legalagent
COPY --from=build /usr/local/bin/node /usr/local/bin/node
COPY --from=harness /opt/legal-harness /opt/legal-harness
ENV LEGAL_HARNESS_ROOT=/opt/legal-harness
WORKDIR /app
COPY --from=build /app/node_modules node_modules
COPY --from=build /app/frontend/dist frontend/dist
COPY --from=build /app/frontend/package.json frontend/package.json
COPY package.json package-lock.json ./
COPY backend backend
COPY skills skills
COPY scripts scripts
RUN mkdir -p /data && chown legalagent:legalagent /data
USER legalagent
EXPOSE 3000
ENTRYPOINT ["node"]
CMD ["backend/pilot/entry.js"]
