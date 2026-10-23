FROM node:22-alpine AS build
RUN apk add --no-cache git
WORKDIR /app
RUN git clone --depth 1 https://github.com/asashiki/sticker-mcp.git .
RUN npm install --include=optional --no-audit --no-fund
RUN npm run build

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000
ENV DATA_DIR=/app/data
COPY --from=build /app/package*.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
RUN mkdir -p /app/data/images && chown -R node:node /app
USER node
EXPOSE 3000
CMD ["sh", "-c", "export PUBLIC_BASE_URL=\"${PUBLIC_BASE_URL:-${RENDER_EXTERNAL_URL}}\"; exec node dist/server.js"]
