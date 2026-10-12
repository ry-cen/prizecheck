# syntax=docker/dockerfile:1
# Better Auth gateway, compiled from auth/src with the repository's TypeScript.
FROM node:22-bookworm-slim AS build
WORKDIR /src
COPY package.json package-lock.json ./
RUN HUSKY=0 npm ci --ignore-scripts
COPY auth ./auth
RUN npx tsc -p auth/tsconfig.json --noEmit false --outDir /out/auth --rootDir auth/src

FROM node:22-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN HUSKY=0 npm ci --omit=dev --ignore-scripts && npm cache clean --force

FROM node:22-bookworm-slim
ARG GIT_COMMIT=unknown
LABEL org.opencontainers.image.source="https://github.com/ry-cen/prizecheck" \
      org.opencontainers.image.revision="${GIT_COMMIT}"
ENV NODE_OPTIONS=--enable-source-maps
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY --from=build /out/auth ./auth
RUN mkdir -p /var/lib/prizecheck/mail && chown -R node:node /var/lib/prizecheck
USER 1000:1000
EXPOSE 3001
CMD ["node", "auth/server.js"]
