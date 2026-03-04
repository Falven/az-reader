# syntax=docker/dockerfile:1.7
ARG NODE_VERSION=22-slim

FROM lwthiker/curl-impersonate:0.6-chrome-slim-bullseye AS curl-impersonate

FROM node:${NODE_VERSION} AS base
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
WORKDIR /workspace
RUN corepack enable

RUN apt-get update \
    && apt-get install -y --no-install-recommends wget gnupg ca-certificates \
    && install -d -m 0755 /etc/apt/keyrings \
    && wget -q -O - https://dl.google.com/linux/linux_signing_key.pub | gpg --dearmor -o /etc/apt/keyrings/google-linux.gpg \
    && chmod a+r /etc/apt/keyrings/google-linux.gpg \
    && echo "deb [arch=amd64 signed-by=/etc/apt/keyrings/google-linux.gpg] http://dl.google.com/linux/chrome/deb/ stable main" > /etc/apt/sources.list.d/google.list \
    && apt-get update \
    && apt-get install -y --no-install-recommends google-chrome-stable fonts-ipafont-gothic fonts-wqy-zenhei fonts-thai-tlwg fonts-kacst fonts-freefont-ttf libxss1 zstd \
    && rm -rf /var/lib/apt/lists/*

COPY --from=curl-impersonate /usr/local/lib/libcurl-impersonate.so /usr/local/lib/libcurl-impersonate.so

FROM base AS build
ENV PUPPETEER_SKIP_DOWNLOAD=1
RUN apt-get update \
    && apt-get install -y --no-install-recommends git \
    && rm -rf /var/lib/apt/lists/*
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY apps/az-reader/package.json ./apps/az-reader/package.json
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --filter ./apps/az-reader... --frozen-lockfile
COPY apps/az-reader ./apps/az-reader
RUN pnpm --filter ./apps/az-reader run build
RUN pnpm deploy --legacy --filter ./apps/az-reader --prod /prod/az-reader

FROM base AS runtime
ENV OVERRIDE_CHROME_EXECUTABLE_PATH=/usr/bin/google-chrome-stable
ENV LD_PRELOAD=/usr/local/lib/libcurl-impersonate.so
ENV CURL_IMPERSONATE=chrome116
ENV CURL_IMPERSONATE_HEADERS=no
ENV NODE_COMPILE_CACHE=node_modules
ENV PORT=8080

RUN groupadd -r -g 10001 jina \
    && useradd -r -u 10001 -g jina -G audio,video -m -s /usr/sbin/nologin jina

WORKDIR /app
COPY --from=build --chown=jina:jina /prod/az-reader/ ./
COPY --from=build --chown=jina:jina /workspace/apps/az-reader/licensed ./licensed

RUN rm -rf /home/jina/.config/chromium \
    && mkdir -p /home/jina/.config/chromium \
    && chown -R jina:jina /app /home/jina/.config

USER jina
RUN NODE_COMPILE_CACHE=node_modules pnpm run dry-run

EXPOSE 3000 3001 8080 8081
STOPSIGNAL SIGTERM
ENTRYPOINT ["node"]
CMD ["build/stand-alone/crawl.js"]
