# shellcheck shell=sh disable=SC2034
# Where this add-on keeps the Codex CLI, and the environment that follows from
# it. Declared HERE and nowhere else: `engine-hooks.sh` derives the core's
# contract from these names, the launchers source this file, and
# `/etc/profile.d/codex-env.sh` gives every shell tab the same thing.
#
# WHY A FILE AND NOT A LINE IN EACH SCRIPT. The CLI does not live in the image:
# it is copied into /data on first start and replaced by `update-codex`, so its
# directory is a property of the add-on, not of any one script. It used to be
# spelled out in three launchers, in the engine contract and in the Dockerfile —
# and the one place nobody wrote it was the place a user meets it. A shell tab is
# a LOGIN shell, /etc/profile rebuilds PATH from scratch, and the image's ENV
# goes with it. Measured on 0.1.0: `codex` in a shell tab answered
# `bash: codex: command not found`, while `/data/npm/bin/codex --version`
# printed `codex-cli 0.155.0`.
#
# POSIX only, and safe to source anywhere: it defines these names, exports the
# three the CLI reads, and adding the directory to PATH twice is a no-op.

CODEX_IMAGE_PREFIX=/opt/codex-npm
CODEX_CLI_PREFIX=/data/npm
CODEX_CLI_BIN=${CODEX_CLI_PREFIX}/bin
CODEX_STATE_DIR=/data/codex
CODEX_PROMPT_HOME=/data/codex-prompt

export CODEX_HOME=${CODEX_STATE_DIR}
export NPM_CONFIG_PREFIX=${CODEX_CLI_PREFIX}

case ":${PATH}:" in
    *":${CODEX_CLI_BIN}:"*) ;;
    *) export PATH="${CODEX_CLI_BIN}:${PATH}" ;;
esac
