#!/usr/bin/env bash
# The Codex engine for the core's start script and provisioning
# (/usr/local/bin/addon-run, /usr/local/bin/provision-extras): its paths and the
# steps only Codex needs. The core sources this file and calls the functions in
# its own order; see the core's README for what each one is for.
# The add-on's names are in /opt/agent-console/adapter/branding.json.
# shellcheck shell=bash disable=SC2034

# The CLI is an npm package. The image carries one under /opt/codex-npm; the
# copy that runs lives in /data, so an update from the console survives a
# restart and an add-on update. Its state (login, sessions, configuration) is a
# separate directory, which an update never touches.
IMAGE_PREFIX=/opt/codex-npm
ENGINE_NPM_PREFIX=/data/npm
ENGINE_BIN_DIR=/data/npm/bin
ENGINE_PROMPT_BIN=/data/npm/bin/codex
ENGINE_INSTRUCTIONS_SOURCE=/usr/share/codex-ha/AGENTS.md
ENGINE_INSTRUCTIONS_FILE=AGENTS.md
ENGINE_STATE_DIR=/data/codex
ENGINE_SKILLS_DIR=/data/codex/skills

# The home prompt-API runs use: it holds nothing but a link to the console's
# login, so a run reads none of the user's instructions or configuration.
ENGINE_PROMPT_HOME=/data/codex-prompt

codex_version() {
    "$1" --version 2>/dev/null | awk '/^codex-cli /{print $2}'
}

# --- Persistent CLI ---
engine_prepare_home() {
    mkdir -p "${ENGINE_STATE_DIR}" "${ENGINE_PROMPT_HOME}"
    chmod 700 "${ENGINE_STATE_DIR}" "${ENGINE_PROMPT_HOME}"

    if [ ! -x "${ENGINE_PROMPT_BIN}" ]; then
        bashio::log.info "First run — copying the Codex CLI into persistent storage..."
        mkdir -p "${ENGINE_NPM_PREFIX}"
        cp -a "${IMAGE_PREFIX}/." "${ENGINE_NPM_PREFIX}/"
    fi

    # /data survives an add-on update, so a copy built against another base image
    # may no longer run here. The login and the sessions live elsewhere and are
    # kept; only the package is replaced.
    if ! "${ENGINE_PROMPT_BIN}" --version >/dev/null 2>&1; then
        bashio::log.warning "The stored Codex CLI does not run on this image — reinstalling it from the image (the login and the sessions are kept)"
        rm -rf "${ENGINE_NPM_PREFIX}"
        mkdir -p "${ENGINE_NPM_PREFIX}"
        cp -a "${IMAGE_PREFIX}/." "${ENGINE_NPM_PREFIX}/"
    fi
}

engine_env() {
    export CODEX_HOME="${ENGINE_STATE_DIR}"
    export NPM_CONFIG_PREFIX="${ENGINE_NPM_PREFIX}"
    # The console's own update command and the CLI's update check must never
    # write outside /data.
    export NPM_CONFIG_UPDATE_NOTIFIER=false
}

# --- The image's CLI, when it is newer than the stored one ---
engine_sync_from_image() {
    local image_bin="${IMAGE_PREFIX}/bin/codex"
    [ -x "${image_bin}" ] || return 0
    [ -x "${ENGINE_PROMPT_BIN}" ] || return 0

    local image_v stored_v newer
    image_v=$(codex_version "${image_bin}")
    stored_v=$(codex_version "${ENGINE_PROMPT_BIN}")

    if [ -z "${image_v}" ] || [ -z "${stored_v}" ]; then
        bashio::log.warning "Could not determine the Codex CLI version for the image sync"
        return 0
    fi

    if [ "${image_v}" = "${stored_v}" ]; then
        bashio::log.info "Codex CLI version: ${stored_v}"
        return 0
    fi

    newer=$(printf '%s\n%s\n' "${image_v}" "${stored_v}" | sort -V | tail -n1)
    if [ "${newer}" = "${image_v}" ]; then
        bashio::log.info "The image has a newer Codex CLI (${image_v} > ${stored_v}) — copying it into persistent storage"
        rm -rf "${ENGINE_NPM_PREFIX}"
        mkdir -p "${ENGINE_NPM_PREFIX}"
        cp -a "${IMAGE_PREFIX}/." "${ENGINE_NPM_PREFIX}/"
    else
        bashio::log.info "The stored Codex CLI (${stored_v}) is newer than the image's (${image_v}) — keeping it"
    fi
}

# --- Authentication ---
#   1. api_key      — an OpenAI API key
#   2. `codex login` in the console — a ChatGPT sign-in, kept in CODEX_HOME
engine_auth() {
    local api_key
    api_key=$(bashio::config 'api_key')

    if bashio::var.has_value "${api_key}"; then
        export OPENAI_API_KEY="${api_key}"
        bashio::log.info "OpenAI API key configured"
    fi

    if [ -f "${ENGINE_STATE_DIR}/auth.json" ]; then
        bashio::log.info "Codex sign-in found in persistent storage"
    elif ! bashio::var.has_value "${api_key}"; then
        bashio::log.notice "No api_key set and no sign-in stored — open the Codex tab and run 'codex login' to sign in with ChatGPT"
    fi
}

# --- Model override ---
engine_model() {
    local model
    model=$(bashio::config 'model')
    if bashio::var.has_value "${model}"; then
        export CODEX_MODEL="${model}"
        bashio::log.info "Model override: ${model}"
    fi
}

# --- Auto-update on startup ---
engine_update() {
    bashio::log.info "Checking for Codex CLI updates..."
    "${ENGINE_PROMPT_BIN}" update 2>&1 \
        || bashio::log.warning "Update check failed (non-critical)"
}

engine_update_disabled() {
    export CODEX_DISABLE_UPDATE_CHECK=1
    bashio::log.info "Auto-update disabled"
}

# --- Skills directory, working-directory trust and the instructions file ---
engine_provision() {
    mkdir -p "${ENGINE_SKILLS_DIR}"

    # The CLI asks about a directory it has not been told to trust, which a
    # console session cannot answer while it is starting. The two directories
    # the add-on works in are trusted here; nothing else is.
    local config="${ENGINE_STATE_DIR}/config.toml"
    [ -f "${config}" ] || : > "${config}"
    local dir
    for dir in /homeassistant /data/workdir; do
        if ! grep -qF "[projects.\"${dir}\"]" "${config}"; then
            printf '\n[projects."%s"]\ntrust_level = "trusted"\n' "${dir}" >> "${config}" \
                && bashio::log.info "Trusting ${dir} for Codex sessions"
        fi
    done
}

engine_console_env() {
    REMOTE_CONTROL=$(jq -r '.remote_control // false' /data/options.json 2>/dev/null || echo false)
    export REMOTE_CONTROL
}

# Prompt runs carry every restriction on their own command line and read no
# settings file at all, so there is nothing to print.
engine_prompt_settings() {
    :
}

# The CLI has no retention setting for its session files: it deletes one only
# when a user deletes that session, and (with a feature that is off by default)
# compresses one older than seven days in place. So the core does the sweeping.
engine_transcript_retention() {
    echo core
}

# --- Provisioning (provision-extras) ---

# Plugins and their marketplaces (the add-on's `marketplaces` / `plugins`
# options; the CLI ships no defaults worth forcing on a user).
engine_provision_plugins() {
    local mp pl name installed_marketplaces installed_plugins
    mapfile -t USER_MARKETPLACES < <(printf '%s\n' "${CC_USER_MARKETPLACES:-}" | sed '/^$/d')
    mapfile -t USER_PLUGINS < <(printf '%s\n' "${CC_USER_PLUGINS:-}" | sed '/^$/d')

    if [ "${#USER_MARKETPLACES[@]}" -gt 0 ]; then
        installed_marketplaces="$(codex plugin marketplace list 2>/dev/null || true)"
        for mp in "${USER_MARKETPLACES[@]}"; do
            [ -n "${mp}" ] || continue
            if ! grep -qF "${mp}" <<<"${installed_marketplaces}"; then
                log "adding marketplace ${mp}"
                codex plugin marketplace add "${mp}" >/dev/null 2>&1 \
                    && log "  ok ${mp}" || log "  FAILED ${mp} (will retry next start)"
            fi
        done
    fi

    if [ "${#USER_PLUGINS[@]}" -gt 0 ]; then
        installed_plugins="$(codex plugin list 2>/dev/null || true)"
        for pl in "${USER_PLUGINS[@]}"; do
            [ -n "${pl}" ] || continue
            name="${pl%@*}"
            if ! grep -qE "(^|\s)${name}(\s|@|$)" <<<"${installed_plugins}"; then
                log "installing plugin ${pl}"
                codex plugin add "${pl}" >/dev/null 2>&1 \
                    && log "  ok ${pl}" || log "  FAILED ${pl} (will retry next start)"
            fi
        done
    fi
}

engine_mcp_has() { codex mcp list 2>/dev/null | grep -qE "(^|\s)${1}(\s|:|$)"; }

# engine_mcp_add NAME [KEY=VALUE...] -- ARGV...
engine_mcp_add() {
    local name="$1" env_args=()
    shift
    while [ "$#" -gt 0 ] && [ "$1" != -- ]; do
        env_args+=(--env "$1")
        shift
    done
    shift
    codex mcp add "${name}" "${env_args[@]}" -- "$@"
}
