ARG BUILD_FROM
# The tag in build.yaml names the base image release; this is the digest of that
# tag's multi-architecture index, so a rebuilt tag cannot change the image. It is
# a pin of its own because build.yaml's build_from accepts a tag only.
# upstream: image-digest hassio-addons/app-debian-base ghcr.io/hassio-addons/debian-base
ARG BUILD_FROM_SHA256=1faf86975f6215114064f597c1b8cc03f3793ff15f2bd1cad5989a675a541062
FROM ${BUILD_FROM}@sha256:${BUILD_FROM_SHA256} AS base

SHELL ["/bin/bash", "-o", "pipefail", "-c"]

# Reproducible build inputs. DEBIAN_SNAPSHOT pins every apt package version;
# SOURCE_DATE_EPOCH (passed by the build script, derived from it) makes pip write
# hash-checked .pyc files and lets the exporter clamp file times.
# upstream: debian-snapshot
ARG DEBIAN_SNAPSHOT=20261119T144258Z
ARG SOURCE_DATE_EPOCH
# npm writes no debug logs into layers; node keeps no compile cache in /tmp.
ARG npm_config_logs_max=0
ARG NODE_DISABLE_COMPILE_CACHE=1

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
# - bubblewrap: the Codex CLI probes PATH for `bwrap` at every start and warns
#   when it is absent, then falls back to its bundled copy
# - bash-static: runs what s6 starts before protect_secrets confines the
#   service (secrets-guard, the finish script). A static shell loads no shared
#   library, so nothing the agent could change takes part in that decision
# - the rest: general command-line tooling for the agent and the MCP servers
RUN --mount=type=bind,source=build-tools/apt-install.sh,target=/tmp/apt-install.sh \
    /tmp/apt-install.sh \
        bash \
        bash-static \
        bubblewrap \
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
        xz-utils

# Node.js from the official dist tarballs (deterministic, architecture-aware).
# The SHA-256 of each platform's tarball is recorded beside the version, taken
# from that release's SHASUMS256.txt when the version is bumped. The tarball is
# checked against the recorded value before it is unpacked, so a download that
# differs from what was seen at the bump — however it came to differ — stops the
# build instead of being installed.
# upstream: nodejs lts-ready
ARG NODE_VERSION=26.13.1
# upstream: nodejs-sha256 linux-x64
ARG NODE_SHA256_AMD64=5c063e46bab0fbc1c17cc445d7ff129cbdcd0471be6ed83b6ab864f8143bc864
# upstream: nodejs-sha256 linux-arm64
ARG NODE_SHA256_ARM64=89e1853138db51e8b82d3e98ba9c0d3f2956a28e5e55ea1b7e12d25aae92d5dd
RUN arch="$(dpkg --print-architecture)" \
    && case "${arch}" in \
         amd64) node_arch="x64";   expected="${NODE_SHA256_AMD64}" ;; \
         arm64) node_arch="arm64"; expected="${NODE_SHA256_ARM64}" ;; \
         *) echo "Unsupported architecture: ${arch}"; exit 1 ;; \
       esac \
    && tarball="node-v${NODE_VERSION}-linux-${node_arch}.tar.xz" \
    && { curl -fsSL --proto '=https' --retry 3 --retry-all-errors --retry-delay 2 -o "/tmp/${tarball}" \
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
    && { curl -fsSL --proto '=https' --retry 3 --retry-all-errors --retry-delay 2 -o /core.tar "${url}" \
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
ARG DEBIAN_SNAPSHOT
ARG SOURCE_DATE_EPOCH
ARG npm_config_logs_max=0
ARG NODE_DISABLE_COMPILE_CACHE=1

# --- Codex CLI (pinned) ---
# The CLI is an npm package, installed into the image under its own prefix. The
# copy that actually runs is in /data (the service seeds it from here on the
# first start), so a sign-in, the sessions and an update from the console
# survive a restart and an add-on update.
#
# The version lives in codex-cli/package.json and every package it installs
# (the CLI and the linux platform build it runs) is named by integrity in the
# lock beside it, so a registry that serves another tarball under the same
# version fails the build instead of shipping (npm skips an optional package that
# fails its integrity check without failing, so the platform build is asserted
# present). Scripts stay off: the package has
# none to run. The packages are placed where `npm install --global` would put
# them, because the console updates this copy with that command. The install is
# asserted afterwards: an upstream change of the package's shape fails the build
# here instead of at a user's next start. Running the CLI creates a randomly
# named directory under /root/.codex/tmp, which would differ in every build, so
# it is removed.
COPY codex-cli /tmp/codex-cli
RUN cd /tmp/codex-cli \
    && wanted="$(jq -r '.dependencies["@openai/codex"]' package.json)" \
    && npm ci --omit=dev --ignore-scripts --no-audit --no-fund \
    && mkdir -p /opt/codex-npm/bin /opt/codex-npm/lib/node_modules \
    && arch="$(case "$(uname -m)" in x86_64) echo x64;; aarch64) echo arm64;; *) echo "unsupported $(uname -m)" >&2; exit 1;; esac)" \
    && { test -d "node_modules/@openai/codex-linux-${arch}" \
         || { echo "The linux-${arch} build of the CLI was not installed (npm skips an optional package that fails its integrity check)"; exit 1; }; } \
    && mv node_modules/@openai /opt/codex-npm/lib/node_modules/@openai \
    && ln -s ../lib/node_modules/@openai/codex/bin/codex.js /opt/codex-npm/bin/codex \
    && cd / && rm -rf /tmp/codex-cli \
    && npm cache clean --force \
    && installed="$(/opt/codex-npm/bin/codex --version | awk '/^codex-cli /{print $2}')" \
    && { [ "${installed}" = "${wanted}" ] \
         || { echo "Locked ${wanted} but the CLI reports '${installed}'"; exit 1; }; } \
    && rm -rf /root/.codex
ENV NPM_CONFIG_PREFIX=/data/npm
ENV PATH="/data/npm/bin:${PATH}"

# --- Browser and image tooling for dashboard screenshots ---
# System Chromium (apt resolves every runtime dependency; works on amd64 and
# arm64) plus CJK, emoji and base fonts so dashboards do not render tofu boxes.
# Both the ha-shot helper and the Playwright MCP server point at
# /usr/bin/chromium, so no browser is downloaded. ImageMagick gives the agent a
# native command for cropping and resizing those screenshots (Pillow, below,
# covers the Python side).
RUN --mount=type=bind,source=build-tools/apt-install.sh,target=/tmp/apt-install.sh \
    /tmp/apt-install.sh \
        chromium \
        fonts-noto-cjk \
        fonts-noto-color-emoji \
        fonts-liberation \
        imagemagick
# Debian's chromium.d/dev-shm decides from `findmnt -T /dev/shm` whether Chromium
# must keep shared memory out of /dev/shm. Where the container runtime stacks two
# mounts on /dev/shm, findmnt prints two lines, the numeric test errors out and the
# flag is never set. Read the first line only; a build whose packaged line no
# longer matches fails here instead of shipping an unfixed snippet.
RUN grep -qF -e '-T /dev/shm)' /etc/chromium.d/dev-shm \
    && sed -i 's|-T /dev/shm)|-T /dev/shm \| head -n 1)|' /etc/chromium.d/dev-shm \
    && { grep -qF -e '-T /dev/shm | head -n 1)' /etc/chromium.d/dev-shm \
         || { echo "The dev-shm decision in /etc/chromium.d was not rewritten"; exit 1; }; }
ENV CHROME_BIN=/usr/bin/chromium
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

# --- Home Assistant command-line tools (static, architecture-aware) ---
# upstream: github-release home-assistant/cli
ARG HA_CLI_VERSION=6.0.0
# upstream: github-asset-sha256 home-assistant/cli ha_amd64
ARG HA_CLI_SHA256_AMD64=faab39046723cb68d43e9d5c8ac5a2cf105f3ecb3f5c8a01c0999c2699c56489
# upstream: github-asset-sha256 home-assistant/cli ha_aarch64
ARG HA_CLI_SHA256_ARM64=514cd052627358d673842e6132d4d0fc88f246c1af767a895c2b529a153c0c59
# upstream: github-release mikefarah/yq
ARG YQ_VERSION=4.54.3
# upstream: github-asset-sha256 mikefarah/yq yq_linux_amd64
ARG YQ_SHA256_AMD64=129534601871538efe0ba4c5e62a34fb1d5f469bcb975c4fddeb467d82974973
# upstream: github-asset-sha256 mikefarah/yq yq_linux_arm64
ARG YQ_SHA256_ARM64=89f69310b61b68d1245065a1241d1fc843f7a36cd6103ffd77ad987613bd1b67
RUN arch="$(dpkg --print-architecture)" \
    && case "${arch}" in \
         amd64) ha_asset=ha_amd64;   ha_sha="${HA_CLI_SHA256_AMD64}"; yq_asset=yq_linux_amd64; yq_sha="${YQ_SHA256_AMD64}" ;; \
         arm64) ha_asset=ha_aarch64; ha_sha="${HA_CLI_SHA256_ARM64}"; yq_asset=yq_linux_arm64; yq_sha="${YQ_SHA256_ARM64}" ;; \
         *) echo "Unsupported architecture: ${arch}" && exit 1 ;; \
       esac \
    && curl -fsSL --retry 3 --retry-all-errors --retry-delay 2 "https://github.com/home-assistant/cli/releases/download/${HA_CLI_VERSION}/${ha_asset}" -o /usr/bin/ha \
    && curl -fsSL --retry 3 --retry-all-errors --retry-delay 2 "https://github.com/mikefarah/yq/releases/download/v${YQ_VERSION}/${yq_asset}" -o /usr/local/bin/yq \
    && { printf '%s  %s\n' "${ha_sha}" /usr/bin/ha | sha256sum -c - \
         || { echo "ha ${HA_CLI_VERSION} does not match the checksum recorded in this repository"; exit 1; }; } \
    && { printf '%s  %s\n' "${yq_sha}" /usr/local/bin/yq | sha256sum -c - \
         || { echo "yq ${YQ_VERSION} does not match the checksum recorded in this repository"; exit 1; }; } \
    && chmod +x /usr/bin/ha /usr/local/bin/yq \
    && ha help >/dev/null && yq --version

# home-assistant-cli (hass-cli) and hass-mcp (registered as an MCP server when
# the Home Assistant token is set): entity and service queries against the Core
# API. Pillow: Python imaging for ad-hoc crops and resizes of dashboard
# screenshots (ImageMagick covers the command-line side).
# hass-mcp's wheel also declares a `test = pytest:main` console script (a
# development entry point, pytest is not a dependency). Installed into
# /usr/local/bin, it would replace the system `test` for anything that runs
# it by name, so it is removed here; the build fails if a file of that name
# is ever something else.
# Versions live in py-tools/requirements.in and move with pins.py; the lock
# beside it names every distribution, transitive ones included, by hash.
RUN --mount=type=bind,source=py-tools/requirements.lock,target=/tmp/requirements.lock \
    pip install --no-cache-dir --break-system-packages --require-hashes --no-deps -r /tmp/requirements.lock \
    && if [ -e /usr/local/bin/test ]; then \
         grep -qx 'from pytest import main' /usr/local/bin/test && rm /usr/local/bin/test; \
       fi

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
# The core's npm installer leaves its random temp directories and the node-pty
# build's temp paths behind; they differ on every build. They are removed after
# each install below until the pinned core cleans up after itself.
COPY cli-tools /opt/cli-tools
RUN cd /opt/cli-tools \
    && /usr/local/lib/install-tools/npm-ci-checked.sh --omit=dev \
    && rm -rf /tmp/tmp.* /tmp/node-compile-cache node_modules/node-pty/build/Makefile node_modules/node-pty/build/config.gypi \
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
    && rm -rf /tmp/tmp.* /tmp/node-compile-cache node_modules/node-pty/build/Makefile node_modules/node-pty/build/config.gypi \
    && npm cache clean --force

# ha-shot helper dependencies (playwright-core drives the system Chromium)
COPY --from=assembly /addon/ha-tools /opt/ha-tools
RUN cd /opt/ha-tools \
    && /usr/local/lib/install-tools/npm-ci-checked.sh --omit=dev \
    && rm -rf /tmp/tmp.* /tmp/node-compile-cache node_modules/node-pty/build/Makefile node_modules/node-pty/build/config.gypi \
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

# /usr/local/{bin,sbin} come first on PATH, so a bundled tool's stray entry
# point named like a system command (a Python package's `test` launcher, say)
# would replace that command for every program that runs it by name. The image
# is not built if anything there hides one.
RUN shadowed="" \
    && for f in /usr/local/bin/* /usr/local/sbin/*; do \
         [ -e "${f}" ] || continue; \
         for d in /usr/sbin /usr/bin /sbin /bin; do \
           if [ -e "${d}/${f##*/}" ]; then shadowed="${shadowed} ${f}"; break; fi; \
         done; \
       done \
    && if [ -n "${shadowed}" ]; then echo "Shadows a system command:${shadowed}" >&2; exit 1; fi \
    && env test 1 -eq 1

# Surface console health to the Supervisor. Hits the loopback health endpoint
# (allowed by the console's IP guard); marks the add-on unhealthy if the Node
# console stops responding. The generous start period covers the first-run setup.
# Docker runs this outside the service's guarded mode (protect_secrets), so it
# runs the static shell by its path — no program found through PATH, no shared
# library — and speaks HTTP itself.
HEALTHCHECK --interval=30s --timeout=5s --start-period=90s --retries=3 \
    CMD ["/usr/bin/bash-static", "-c", "exec 3<>/dev/tcp/127.0.0.1/8099 && printf 'GET /api/health HTTP/1.0\\r\\nHost: 127.0.0.1\\r\\n\\r\\n' >&3 && read -r -t 4 status <&3 && [[ $status =~ ^HTTP/1\\.[01]\\ 2[0-9][0-9] ]]"]

LABEL \
    io.hass.name="Codex" \
    io.hass.description="Codex AI assistant for Home Assistant" \
    io.hass.type="addon"
