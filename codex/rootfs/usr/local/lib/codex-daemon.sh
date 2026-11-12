# shellcheck shell=bash
# The Codex CLI's background service follows the CLI this add-on installed.
#
# The console's CLI starts a background app-server (`daemon_auto_start`, on by
# default) from its own copy of the CLI under $CODEX_HOME/packages, and that copy
# then updates itself from Codex's releases. The add-on is the one that decides
# the CLI version (`update-codex`, Auto-Update, a rollback to an older version),
# so without this the console meets a service of another version: measured with
# 0.167.1 -> 0.167.2, a fresh start after `npm install` still ran the service at
# 0.167.1, and the TUI said "A background Codex service is running v0.167.1,
# older than your Codex CLI v0.167.2".
#
# `codex app-server daemon update --from-cli --yes` copies the running CLI into
# the service's packages, pins it (the service stops updating on its own) and
# restarts the service only if it is running. Without an installed service it
# refuses with "no daemon package is selected" — nothing to match then; the CLI
# installs one from itself the first time it needs it.
#
# The CLI version it was last matched to is kept in CODEX_DAEMON_PINNED, so the
# copy happens once per version change, not at every console start.

# Callers source codex-env.sh first (it names CODEX_DAEMON_PINNED and puts the
# CLI on PATH).

pin_codex_daemon() {
    local cli pinned out
    cli=$(codex --version 2>/dev/null | awk '/^codex-cli /{print $2}')
    [ -n "${cli}" ] || return 0
    pinned=$(cat "${CODEX_DAEMON_PINNED}" 2>/dev/null)
    [ "${pinned}" = "${cli}" ] && return 0
    if out=$(timeout 300 codex app-server daemon update --from-cli --yes 2>&1 </dev/null); then
        printf '%s\n' "${cli}" > "${CODEX_DAEMON_PINNED}"
        echo "Codex background service: matched to Codex CLI ${cli}"
        return 0
    fi
    case "${out}" in
        *"no daemon package is selected"*) return 0 ;;
    esac
    echo "Codex background service: could not match it to Codex CLI ${cli}: ${out##*$'\n'}" >&2
    return 0
}
