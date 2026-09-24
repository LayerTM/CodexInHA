ARG BUILD_FROM
FROM ${BUILD_FROM} AS base

SHELL ["/bin/bash", "-o", "pipefail", "-c"]

ENV TERM=xterm-256color
# Authoritative truecolor signal: many terminal UIs gate 24-bit colour on
# COLORTERM rather than on the TERM string. The pipe already carries truecolor
# (tmux terminal-overrides ",*:Tc"); this lets applications actually use it.
# Inherited by the tmux server and so by every window and shell.
ENV COLORTERM=truecolor
ENV LANG=C.UTF-8

# System packages:
# - build-essential python3: node-pty's native build and npm packages with gyp
#   dependencies
# - tmux: the session survives a browser disconnect
# - ripgrep: fast search from the console
# - the rest: general command-line tooling for the agent and the MCP servers
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        bash \
        build-essential \
        ca-certificates \
        curl \
        git \
        gnupg \
        jq \
        less \
        nano \
        openssh-client \
        procps \
        python3 \
        python3-pip \
        python3-venv \
        ripgrep \
        tmux \
        unzip \
        xz-utils \
    && rm -rf /var/lib/apt/lists/*

# Node.js from the official dist tarballs (deterministic, architecture-aware).
# The SHA-256 of each platform's tarball is recorded beside the version, taken
# from that release's SHASUMS256.txt when the version is bumped. The tarball is
# checked against the recorded value before it is unpacked, so a download that
# differs from what was seen at the bump — however it came to differ — stops the
# build instead of being installed.
# upstream: nodejs lts-ready
ARG NODE_VERSION=26.10.0
# upstream: nodejs-sha256 linux-x64
ARG NODE_SHA256_AMD64=ca70e9e349de048b9522abb3adc05b3bd6f43c5ffd3ec57916c7da292f59f022
# upstream: nodejs-sha256 linux-arm64
ARG NODE_SHA256_ARM64=7a6353f63eb3d04765004b4adf172616243e4522434635cb1d26288658b04ab5
RUN arch="$(dpkg --print-architecture)" \
    && case "${arch}" in \
         amd64) node_arch="x64";   expected="${NODE_SHA256_AMD64}" ;; \
         arm64) node_arch="arm64"; expected="${NODE_SHA256_ARM64}" ;; \
         *) echo "Unsupported architecture: ${arch}"; exit 1 ;; \
       esac \
    && tarball="node-v${NODE_VERSION}-linux-${node_arch}.tar.xz" \
    && { curl -fsSL --proto '=https' --retry 3 --retry-delay 2 -o "/tmp/${tarball}" \
           "https://nodejs.org/dist/v${NODE_VERSION}/${tarball}" \
         || { echo "Could not download ${tarball}"; exit 1; }; } \
    && { echo "${expected}  /tmp/${tarball}" | sha256sum -c --strict - \
         || { echo "${tarball} does not match the recorded SHA-256 ${expected}"; exit 1; }; } \
    && tar -xJf "/tmp/${tarball}" -C /usr/local --strip-components=1 --no-same-owner \
    && rm -f "/tmp/${tarball}" \
    && node --version && npm --version

# --- ha-agent-core (pinned, checksum-verified) ---
# The console, the prompt server, tmux wiring and the shared helper scripts come
# from the ha-agent-core release pinned in core/core.lock.json. Only the lock
# chooses the URL and the expected SHA-256; core/verify-core.js is the reviewed
# copy kept in this repository, never the one inside the archive.
FROM base AS core-archive
COPY core/core.lock.json core/verify-core.js /tmp/core/
RUN url="$(node /tmp/core/verify-core.js url --lock /tmp/core/core.lock.json)" \
    && { curl -fsSL --proto '=https' --retry 3 --retry-delay 2 -o /core.tar "${url}" \
         || { echo "Could not download ha-agent-core from ${url}"; exit 1; }; }

# The add-on's own files plus the core, merged only after the archive matches the
# lock and neither side claims a path of the other (core/assemble.sh).
FROM base AS assembly
COPY core /tmp/core
COPY app /tmp/addon/app
COPY rootfs /tmp/addon/rootfs
COPY --from=core-archive /core.tar /tmp/core.tar
RUN /tmp/core/assemble.sh /tmp/core.tar /tmp/addon /addon

FROM base
SHELL ["/bin/bash", "-o", "pipefail", "-c"]

# --- Codex CLI (pinned) ---
# The CLI is an npm package, installed into the image under its own prefix. The
# copy that actually runs is in /data (the service seeds it from here on the
# first start), so a sign-in, the sessions and an update from the console
# survive a restart and an add-on update.
#
# The version is pinned here rather than resolved at build time, so two builds
# of the same commit ship the same CLI. The install is asserted afterwards: an
# upstream change of the package's shape fails the build here instead of at a
# user's next start.
# upstream: npm @openai/codex
ARG CODEX_VERSION=0.156.1
ENV NPM_CONFIG_PREFIX=/opt/codex-npm
RUN npm install --global --no-audit --no-fund "@openai/codex@${CODEX_VERSION}" \
    && npm cache clean --force \
    && installed="$(/opt/codex-npm/bin/codex --version | awk '/^codex-cli /{print $2}')" \
    && { [ "${installed}" = "${CODEX_VERSION}" ] \
         || { echo "Pinned ${CODEX_VERSION} but the CLI reports '${installed}'"; exit 1; }; }
ENV NPM_CONFIG_PREFIX=/data/npm
ENV PATH="/data/npm/bin:${PATH}"

# --- Browser and image tooling for dashboard screenshots ---
# System Chromium (apt resolves every runtime dependency; works on amd64 and
# arm64) plus CJK, emoji and base fonts so dashboards do not render tofu boxes.
# Both the ha-shot helper and the Playwright MCP server point at
# /usr/bin/chromium, so no browser is downloaded. ImageMagick gives the agent a
# native command for cropping and resizing those screenshots (Pillow, below,
# covers the Python side).
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        chromium \
        fonts-noto-cjk \
        fonts-noto-color-emoji \
        fonts-liberation \
        imagemagick \
    && rm -rf /var/lib/apt/lists/*
ENV CHROME_BIN=/usr/bin/chromium
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

# --- Home Assistant command-line tools (static, architecture-aware) ---
# upstream: github-release home-assistant/cli
ARG HA_CLI_VERSION=5.5.0
# upstream: github-release mikefarah/yq
ARG YQ_VERSION=4.53.6
RUN arch="$(dpkg --print-architecture)" \
    && case "${arch}" in \
         amd64) ha_asset=ha_amd64; yq_asset=yq_linux_amd64 ;; \
         arm64) ha_asset=ha_aarch64; yq_asset=yq_linux_arm64 ;; \
         *) echo "Unsupported architecture: ${arch}" && exit 1 ;; \
       esac \
    && curl -fsSL --retry 3 --retry-delay 2 "https://github.com/home-assistant/cli/releases/download/${HA_CLI_VERSION}/${ha_asset}" -o /usr/bin/ha \
    && curl -fsSL --retry 3 --retry-delay 2 "https://github.com/mikefarah/yq/releases/download/v${YQ_VERSION}/${yq_asset}" -o /usr/local/bin/yq \
    && chmod +x /usr/bin/ha /usr/local/bin/yq \
    && ha help >/dev/null && yq --version

# home-assistant-cli (hass-cli) and hass-mcp (registered as an MCP server when
# the Home Assistant token is set): entity and service queries against the Core
# API. Pillow: Python imaging for ad-hoc crops and resizes of dashboard
# screenshots (ImageMagick covers the command-line side).
# upstream: pypi homeassistant-cli
ARG HASS_CLI_VERSION=1.0.0
# upstream: pypi hass-mcp
ARG HASS_MCP_VERSION=0.6.0
# upstream: pypi Pillow
ARG PILLOW_VERSION=12.3.0
RUN pip install --no-cache-dir --break-system-packages \
        "homeassistant-cli==${HASS_CLI_VERSION}" \
        "hass-mcp==${HASS_MCP_VERSION}" \
        "Pillow==${PILLOW_VERSION}"

# Force HTTPS for GitHub clones (plugin marketplaces) — the container has no SSH key.
RUN git config --system url."https://github.com/".insteadOf "git@github.com:"

# Dependencies are installed with the core's checked install: only the reviewed
# install scripts run (node-pty compiles against the headers of the Node
# installed above, nothing is downloaded), and development dependencies stay out.
COPY --from=assembly /addon/install-tools /usr/local/lib/install-tools

# Bundled command-line tools, installed from cli-tools/package-lock.json with the
# same checked install, and each command they declare linked into
# /usr/local/bin: @playwright/mcp (playwright-mcp) is the browser MCP server; it
# uses the system Chromium through --executable-path at runtime, so no browser
# is downloaded. Their versions live in cli-tools/package.json.
COPY cli-tools /opt/cli-tools
RUN cd /opt/cli-tools \
    && /usr/local/lib/install-tools/npm-ci-checked.sh --omit=dev \
    && npm cache clean --force \
    && for dep in $(jq -r '.dependencies | keys[]' package.json); do \
         jq -r 'if (.bin | type) == "string" then .name | split("/") | last else .bin | keys[] end' \
           "node_modules/${dep}/package.json" \
           || { echo "Cannot read the commands of ${dep}" >&2; exit 1; }; \
       done \
     | while read -r cmd; do \
         { test -x "node_modules/.bin/${cmd}" && test ! -e "/usr/local/bin/${cmd}"; } \
           || { echo "Cannot link ${cmd}: missing in node_modules/.bin or already in /usr/local/bin"; exit 1; }; \
         ln -s "/opt/cli-tools/node_modules/.bin/${cmd}" "/usr/local/bin/${cmd}"; \
       done \
    && test -x /usr/local/bin/playwright-mcp

# Web console application
COPY --from=assembly /addon/app /opt/agent-console
RUN cd /opt/agent-console \
    && /usr/local/lib/install-tools/npm-ci-checked.sh --omit=dev \
    && npm cache clean --force

# ha-shot helper dependencies (playwright-core drives the system Chromium)
COPY --from=assembly /addon/ha-tools /opt/ha-tools
RUN cd /opt/ha-tools \
    && /usr/local/lib/install-tools/npm-ci-checked.sh --omit=dev \
    && npm cache clean --force \
    && rm -rf /usr/local/lib/install-tools

# Bundled Home Assistant skill pack (seeded into the agent's skills on first run)
COPY skills /opt/ha-skills

# S6 services, scripts, the default instructions file
COPY --from=assembly /addon/rootfs /

RUN chmod +x /etc/s6-overlay/s6-rc.d/codex/run \
             /etc/s6-overlay/s6-rc.d/codex/finish \
             /usr/local/bin/addon-run \
             /usr/local/bin/agent-ask \
             /usr/local/bin/agent-usage \
             /usr/local/bin/start-codex \
             /usr/local/bin/start-remote \
             /usr/local/bin/update-codex \
             /usr/local/bin/provision-extras \
             /usr/local/bin/usage-upkeep \
             /usr/local/bin/cc-monitor \
             /usr/local/bin/cc-digest \
             /usr/local/bin/cc-alerts \
             /usr/local/bin/ha-shot \
             /usr/local/bin/ha-check \
             /usr/local/bin/ha-state \
             /usr/local/bin/ha-notify \
             /usr/local/bin/ha-backup \
             /usr/local/bin/ha-audit \
             /usr/local/bin/ha-usage

# Surface console health to the Supervisor. Hits the loopback health endpoint
# (allowed by the console's IP guard); marks the add-on unhealthy if the Node
# console stops responding. The generous start period covers the first-run setup.
HEALTHCHECK --interval=30s --timeout=5s --start-period=90s --retries=3 \
    CMD ["curl", "-fsS", "http://127.0.0.1:8099/api/health"]

LABEL \
    io.hass.name="Codex" \
    io.hass.description="Codex AI assistant for Home Assistant" \
    io.hass.type="addon"
