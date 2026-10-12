# syntax=docker/dockerfile:1
# Built SPA behind nginx; /auth and /api go to the gateway. The single browser-facing service.
FROM node:22-bookworm-slim AS build
WORKDIR /src
COPY package.json package-lock.json ./
RUN HUSKY=0 npm ci --ignore-scripts
COPY web ./web
# `npm run build` also runs the generated-client checks, which need the Python venv; CI runs them in the verify job.
RUN npx vite build --config web/vite.config.ts

FROM nginxinc/nginx-unprivileged:1.28-alpine
ARG GIT_COMMIT=unknown
LABEL org.opencontainers.image.source="https://github.com/ry-cen/prizecheck" \
      org.opencontainers.image.revision="${GIT_COMMIT}"
COPY deploy/docker/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /src/dist/web /usr/share/nginx/html
EXPOSE 8080
