# syntax=docker/dockerfile:1
# FastAPI service, migration runner and operator scripts. Layout mirrors the repository so
# scripts/*.py resolve api/ and migrations/ through parents[1].
FROM python:3.14-slim AS deps
ENV PIP_NO_CACHE_DIR=1 PIP_DISABLE_PIP_VERSION_CHECK=1
COPY api/requirements.txt /tmp/requirements.txt
# Test runners stay out of the runtime image (httpx is a runtime dependency of catalog and price fetches).
RUN grep -vE '^(pytest|pytest-xdist)\b' /tmp/requirements.txt > /tmp/runtime-requirements.txt \
 && python -m venv /opt/venv \
 && /opt/venv/bin/pip install -r /tmp/runtime-requirements.txt

FROM python:3.14-slim
ARG GIT_COMMIT=unknown
LABEL org.opencontainers.image.source="https://github.com/ry-cen/prizecheck" \
      org.opencontainers.image.revision="${GIT_COMMIT}"
ENV PATH=/opt/venv/bin:$PATH \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PYTHONPATH=/app/api
RUN groupadd --system --gid 10001 prizecheck \
 && useradd --system --uid 10001 --gid prizecheck --home-dir /app --shell /usr/sbin/nologin prizecheck \
 && mkdir -p /var/lib/prizecheck/public /var/lib/prizecheck/price-runners \
 && chown -R prizecheck:prizecheck /var/lib/prizecheck
COPY --from=deps /opt/venv /opt/venv
COPY api/app /app/api/app
COPY migrations /app/migrations
COPY scripts /app/scripts
# The pinned scanner model id (app.host_readiness counts only that model's fingerprints, as the index job does).
COPY web/scanner-models.lock.json /app/web/scanner-models.lock.json
WORKDIR /app/api
USER 10001:10001
EXPOSE 8000
# One process, no reload, no access log: request URLs can carry public capability tokens.
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000", "--no-access-log", "--timeout-graceful-shutdown", "20"]
