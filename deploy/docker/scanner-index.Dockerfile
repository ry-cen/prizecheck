# syntax=docker/dockerfile:1
# The card scanner's fingerprint index job (#312, ADR 0017): scripts/scanner_index_job.py, run by hand after a catalog pull
# (`compose run --rm scanner-index [--full]`). A separate image because OpenCV, ONNX Runtime and the 24 MB embedder do not
# belong in the API image. Build with the repository root as context.

# The embedder, verified by size and sha256 against the lock file the web image uses, laid out as
# /models/<sha256[0:16]>/<name>. The fetch script downloads every pinned file; the OCR model and dictionary are for the
# phone, so the rest is deleted here. The build needs to reach huggingface.co.
FROM node:22-bookworm-slim AS models
WORKDIR /src
COPY scripts/fetch-scanner-models.mjs ./scripts/fetch-scanner-models.mjs
COPY web/scanner-models.lock.json ./web/scanner-models.lock.json
RUN node scripts/fetch-scanner-models.mjs --out /models \
 && node -e 'const l=require("/src/web/scanner-models.lock.json");const k=new Set(l.files.filter(f=>f.role==="embedder").map(f=>f.sha256.slice(0,16)));const fs=require("fs");for(const d of fs.readdirSync("/models"))if(!k.has(d))fs.rmSync("/models/"+d,{recursive:true})'

# Python 3.13, not the API image's 3.14: opencv-python-headless 4.12.0.88 needs numpy<2.3, and numpy 2.2.6, the newest below
# that, has no cp314 wheel. Move both pins together.
FROM python:3.13-slim AS deps
ENV PIP_NO_CACHE_DIR=1 PIP_DISABLE_PIP_VERSION_CHECK=1
COPY api/requirements-scanner.txt /tmp/requirements-scanner.txt
RUN python -m venv /opt/venv \
 && /opt/venv/bin/pip install -r /tmp/requirements-scanner.txt

FROM python:3.13-slim AS runtime
ARG GIT_COMMIT=unknown
LABEL org.opencontainers.image.source="https://github.com/ry-cen/prizecheck" \
      org.opencontainers.image.revision="${GIT_COMMIT}"
ENV PATH=/opt/venv/bin:$PATH \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    SCANNER_MODELS_DIR=/opt/scanner-models
RUN groupadd --system --gid 10001 prizecheck \
 && useradd --system --uid 10001 --gid prizecheck --home-dir /app --shell /usr/sbin/nologin prizecheck
COPY --from=deps /opt/venv /opt/venv
COPY --from=models /models /opt/scanner-models
COPY web/scanner-models.lock.json /app/web/scanner-models.lock.json
COPY scripts/scanner_index_job.py /app/scripts/scanner_index_job.py
WORKDIR /app
USER 10001:10001

# CI builds this stage and runs it: the real-model test (the only test that needs ONNX Runtime) against the pinned embedder.
FROM runtime AS test
ENV SCANNER_REAL_MODEL_REQUIRED=1
USER root
RUN pip install --no-cache-dir "pytest>=8,<9"
COPY api/tests/test_scanner_index_job.py /app/api/tests/test_scanner_index_job.py
USER 10001:10001
ENTRYPOINT []
CMD ["python", "-m", "pytest", "-m", "slow", "--noconftest", "-p", "no:cacheprovider", "-W", "ignore::pytest.PytestUnknownMarkWarning", "api/tests/test_scanner_index_job.py"]

# The default (last) stage is the job.
FROM runtime AS job
ENTRYPOINT ["python", "scripts/scanner_index_job.py"]
