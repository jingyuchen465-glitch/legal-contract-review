FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY backend/package.json backend/package.json
COPY frontend/package.json frontend/package.json
RUN npm ci --no-audit --no-fund
COPY frontend frontend
RUN npm run build
RUN npm prune --omit=dev --no-audit --no-fund

FROM postgres:18-bookworm AS runtime
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates libstdc++6 fonts-noto-cjk && rm -rf /var/lib/apt/lists/* && useradd -m -u 1000 legalagent
COPY --from=build /usr/local/bin/node /usr/local/bin/node
WORKDIR /app
COPY --from=build /app/node_modules node_modules
COPY --from=build /app/frontend/dist frontend/dist
COPY --from=build /app/frontend/package.json frontend/package.json
COPY package.json package-lock.json ./
COPY backend backend
COPY scripts scripts
RUN mkdir -p /data && chown legalagent:legalagent /data
USER legalagent
EXPOSE 3000
ENTRYPOINT ["node"]
CMD ["backend/pilot/entry.js"]
