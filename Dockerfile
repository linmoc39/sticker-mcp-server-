FROM node:22-alpine AS build
WORKDIR /app

# The deployment repository contains only this Dockerfile.
# Fetch the actual application source from the upstream project.
RUN apk add --no-cache git
RUN git clone --depth 1 https://github.com/asashiki/sticker-mcp.git /app

# Override the upstream local-only storage with GitHub-backed persistence.
COPY storage.ts /tmp/storage.ts
RUN cp /tmp/storage.ts /app/src/storage.ts

RUN npm ci --include=optional --no-audit --no-fund
RUN npm run build
RUN npm prune --omit=dev --include=optional

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000
ENV DATA_DIR=/app/data

COPY --from=build /app/package.json ./package.json
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist

RUN mkdir -p /app/data/images && chown -R node:node /app
USER node
EXPOSE 3000
VOLUME ["/app/data"]
CMD ["sh", "-c", "export PUBLIC_BASE_URL=\"${PUBLIC_BASE_URL:-${RENDER_EXTERNAL_URL}}\"; exec node dist/server.js"]
