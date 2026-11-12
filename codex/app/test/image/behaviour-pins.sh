#!/usr/bin/env bash
# Behaviour pins that only the built image can answer: that nothing bundled
# shadows a system command, where the Codex CLI the service runs comes from and
# how a shell tab finds it, what the Codex tab launches with, and how the CLI is
# updated (from a shell and from the console's Update button).
#
# Runs as root inside a throwaway container of the add-on image:
#   docker run --rm --network none -v "$PWD/codex/app/test/image:/pins-src:ro" \
#     --entrypoint bash <image> /pins-src/behaviour-pins.sh
#
# The Codex CLI is replaced by a recording stand-in before anything below runs,
# so nothing here needs an account or a network, and the add-on options are
# served to bashio from its own cache directory, which is where bashio looks
# before it asks the Supervisor.
set -u

pass=0
fail=0
ok() { pass=$((pass + 1)); echo "ok   $1"; }
bad() { fail=$((fail + 1)); echo "FAIL $1"; if [ -n "${2:-}" ]; then printf '     %s\n' "$2"; fi; }
eq() { if [ "$2" = "$3" ]; then ok "$1"; else bad "$1" "got [$2] want [$3]"; fi; }
yes_() { if "${@:2}"; then ok "$1"; else bad "$1"; fi; }
no_() { if "${@:2}"; then bad "$1"; else ok "$1"; fi; }

P=/pins
SERVICE=/etc/s6-overlay/s6-rc.d/codex/run
BASE_PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
IMG=5.0.0
rm -rf "${P}"
mkdir -p "${P}"

# --- the image as built: nothing bundled shadows a system command ---------------
# /usr/local/bin comes first on PATH, so a bundled tool's stray entry point
# with the name of a system command (a Python package's `test` launcher, say)
# would replace that command for every program that runs it by name.
shadowed=""
for f in /usr/local/bin/* /usr/local/sbin/*; do
    [ -e "${f}" ] || continue
    for d in /usr/sbin /usr/bin /sbin /bin; do
        if [ -e "${d}/${f##*/}" ]; then shadowed="${shadowed} ${f} (${d}/${f##*/})"; break; fi
    done
done
eq "nothing in /usr/local shadows a system command" "${shadowed}" ""
eq "test run by name on PATH is the system's" "$(PATH="${BASE_PATH}" env test 1 -eq 1 2>&1; echo "exit $?")" "exit 0"

# --- stand-ins -------------------------------------------------------------------
# mkfake <path> <version>: a `codex` that logs every call (resolved path, working
# directory, HOME, arguments quoted) and carries its version inside itself, so a
# copy made by the service script reports the version of what was copied.
mkfake() {
    mkdir -p "$(dirname "$1")"
    rm -f "$1"
    cat > "$1" <<EOF
#!/bin/bash
FAKE_VERSION=$2
{ printf '%s|%s|%s|' "\$(readlink -f "\$0")" "\$(pwd)" "\$HOME"; [ \$# -gt 0 ] && printf '%q ' "\$@"; echo; } >> /pins/codex.log
for a in "\$@"; do printf '%s' "\$a" | jq -Rs .; done | jq -cs . >> /pins/codex-args.jsonl
case "\$*" in
    --version) echo "codex-cli \${FAKE_VERSION}" ;;
    update) if [ -f /pins/update-fails ]; then echo "update refused" >&2; exit 3; fi; echo "checked for updates" ;;
    *) ;;
esac
exit 0
EOF
    chmod +x "$1"
}

# The image's own copy becomes a stand-in of version IMG. The real CLI is covered
# by the checks that run it directly; nothing below needs it.
mkfake /opt/codex-npm/bin/codex "${IMG}"

# The console process the service script ends in: record how it was started.
mkdir -p /usr/local/sbin
cat > /usr/local/sbin/node <<'EOF'
#!/bin/bash
printf '%s\n' "$*" > /pins/console-args
/usr/local/bin/node -e 'require("fs").writeFileSync("/pins/console-env.json", JSON.stringify(process.env))'
EOF
chmod +x /usr/local/sbin/node

# `npm install` as the version update runs it: record the call and make the
# persistent stand-in report the version that was asked for.
cat > /usr/local/sbin/npm <<'EOF'
#!/bin/bash
printf '%s|%s\n' "${NPM_CONFIG_PREFIX:-}" "$*" >> /pins/npm.log
if [ -f /pins/npm-fails ]; then echo "npm refused" >&2; exit 4; fi
all="$*"
case "${all}" in
    install*@openai/codex@*)
        version="${all##*@openai/codex@}"
        sed -i "s/^FAKE_VERSION=.*/FAKE_VERSION=${version%% *}/" /data/npm/bin/codex ;;
esac
exit 0
EOF
chmod +x /usr/local/sbin/npm

DEFAULTS='{"api_key":"","ha_token":"","bypass_permissions":false,"auto_update":true,"model":"",
"custom_instructions":"","environment_vars":[],"init_commands":[],"plugins":[],"marketplaces":[],"skills_git":"",
"extra_args":[],"launch_command":"","quick_prompts":[],"upload_retention_days":14,"remote_control":false,
"monitoring_interval_hours":0,"daily_digest_time":"","proactive_alerts":false,"proactive_alerts_interval_minutes":15,
"prompt_api":true,"api_token":"","prompt_ha_token":""}'

# options <json overrides>: /data/options.json plus bashio's cached copy of it.
options() {
    local merged
    merged="$(jq -cn --argjson a "${DEFAULTS}" --argjson b "$1" '$a + $b')"
    mkdir -p /data /tmp/.bashio
    rm -f /tmp/.bashio/*
    printf '%s' "${merged}" > /data/options.json
    printf '%s' "${merged}" > /tmp/.bashio/addons.self.options.config.cache
    printf '%s' '7.7.7' > /tmp/.bashio/addons.self.version.cache
}

reset() {
    rm -rf /data /homeassistant
    rm -f "${P}"/codex.log "${P}"/codex-args.jsonl "${P}"/npm.log "${P}"/console-* "${P}"/update-fails \
        "${P}"/npm-fails "${P}"/launched "${P}"/run.out "${P}"/start.out
    mkdir -p /data
}

envv() { jq -r --arg k "$1" 'if has($k) then .[$k] else "<unset>" end' "${P}/console-env.json"; }
persistent_version() { /data/npm/bin/codex --version 2>/dev/null | awk '{print $2}'; }
# Every call of the stand-in except the version probes the launchers make.
codex_calls() { cut -d'|' -f4- "${P}/codex.log" 2>/dev/null | grep -v -- '^--version' | sed 's/ $//'; }
launch_args() { jq -c . "${P}/codex-args.jsonl" 2>/dev/null | grep -v '^\["--version"\]$' | head -1; }

# The container environment s6 keeps for its services. with-contenv starts the
# service with exactly these (and PATH), so PINS_NOT_CONTENV below must not
# reach the console and PINS_CONTENV must.
mkdir -p /run/s6/container_environment
printf '/root' > /run/s6/container_environment/HOME
printf 'from-contenv' > /run/s6/container_environment/PINS_CONTENV

# run_service: the s6 service script, as the Supervisor starts it (minus s6).
run_service() {
    env -i PATH="${BASE_PATH}" PINS_NOT_CONTENV=1 timeout 90 "${SERVICE}" > "${P}/run.out" 2>&1
    local status=$?
    # provisioning is started in the background; let it finish before asserting
    for _ in $(seq 1 60); do
        grep -q 'provisioning complete' /data/provision.log 2>/dev/null && break
        sleep 0.5
    done
    return "${status}"
}

# --- 1. first start: the CLI the service runs is the image's, copied to /data ---
echo "# service script: fresh install"
reset
options '{"api_key":"sk-pins-0000","model":"pins-model","auto_update":false,"environment_vars":["PINS_FOO=bar"]}'
run_service
eq "service script exits 0 after handing over to the console" "$?" 0
eq "console is started as the last step" "$(cat "${P}/console-args" 2>/dev/null)" "/opt/agent-console/server/index.js"
eq "the service hands the container environment to the start script" "$(envv PINS_CONTENV)" from-contenv
eq "and nothing else of its caller's" "$(envv PINS_NOT_CONTENV)" "<unset>"
yes_ "the first start copies the CLI out of the image" grep -q 'copying the Codex CLI into persistent storage' "${P}/run.out"
yes_ "the copy is an executable file under /data/npm" test -x /data/npm/bin/codex
eq "the persistent copy is the image's CLI" "$(persistent_version)" "${IMG}"
eq "the image's own copy is left where it was" "$(/opt/codex-npm/bin/codex --version | awk '{print $2}')" "${IMG}"
eq "the console is given the persistent CLI to run prompts with" \
    "$(envv CLAUDE_PROMPT_BIN)" /data/npm/bin/codex
eq "PATH starts with the persistent CLI's directory" "$(envv PATH | cut -d: -f1)" /data/npm/bin
eq "CODEX_HOME is the console's own state directory" "$(envv CODEX_HOME)" /data/codex
eq "npm installs under the persistent prefix" "$(envv NPM_CONFIG_PREFIX)" /data/npm
eq "api_key -> CODEX_API_KEY" "$(envv CODEX_API_KEY)" sk-pins-0000
eq "model -> CODEX_MODEL" "$(envv CODEX_MODEL)" pins-model
eq "auto_update off -> CODEX_DISABLE_UPDATE_CHECK" "$(envv CODEX_DISABLE_UPDATE_CHECK)" 1
no_ "auto_update off -> no update call" grep -q '|update $' "${P}/codex.log"
eq "environment_vars are exported" "$(envv PINS_FOO)" bar
yes_ "the instructions file is written to the CLI's own home" grep -q 'BEGIN add-on instructions' /data/codex/AGENTS.md
eq "the add-on's working directories are trusted" \
    "$(grep -c '^\[projects\.' /data/codex/config.toml)" 2

# A login shell rebuilds PATH from /etc/profile; the add-on puts its own directory
# back from /etc/profile.d, so a shell tab finds the persistent copy.
eq "codex on a login shell's PATH is the persistent copy" \
    "$(env -i HOME=/root bash -lc 'command -v codex' 2>&1)" /data/npm/bin/codex
eq "a login shell reads the same CODEX_HOME" "$(env -i HOME=/root bash -lc 'echo "${CODEX_HOME}"' 2>&1)" /data/codex

echo "# service script: existing install"
reset
mkfake /data/npm/bin/codex 9.0.0
options '{"auto_update":true}'
run_service
eq "service script exits 0" "$?" 0
eq "a newer persistent CLI is kept" "$(persistent_version)" 9.0.0
yes_ "auto_update on -> the persistent CLI is asked to update" grep -qE '^/data/npm/bin/codex\|.*\|update $' "${P}/codex.log"
eq "auto_update on -> CODEX_DISABLE_UPDATE_CHECK unset" "$(envv CODEX_DISABLE_UPDATE_CHECK)" "<unset>"

reset
mkfake /data/npm/bin/codex 1.0.0
options '{"auto_update":false}'
run_service
eq "an older persistent CLI is replaced by the image's" "$(persistent_version)" "${IMG}"
rm -f /usr/local/sbin/node

# --- 2. the Codex tab (start-codex) ----------------------------------------------
# start_codex: the launcher loops forever (restart menu); its first calls are the pin.
start_codex() {
    env -i PATH="${BASE_PATH}" HOME=/root timeout 4 bashio /usr/local/bin/start-codex < /dev/null > "${P}/start.out" 2>&1
}
first_cwd() { grep -v -E '\|--version $' "${P}/codex.log" | head -1 | cut -d'|' -f2; }

echo "# start-codex"
reset
mkfake /data/npm/bin/codex "${IMG}"
mkdir -p /homeassistant /data/workdir
options '{"bypass_permissions":true,"model":"pins-model","extra_args":["--search","x y"]}'
start_codex
eq "bypass on: the bypass flag, the model, then extra_args" "$(launch_args)" \
    '["--dangerously-bypass-approvals-and-sandbox","--model","pins-model","--search","x y"]'
eq "launched in /homeassistant when it is there" "$(first_cwd)" /homeassistant
yes_ "the exit menu names the version" grep -q "Codex exited. \[Codex CLI ${IMG}\]" "${P}/start.out"

reset
mkfake /data/npm/bin/codex "${IMG}"
mkdir -p /data/workdir
options '{"bypass_permissions":false}'
start_codex
eq "bypass off: the container's own sandbox setting, nothing else" "$(launch_args)" '["--sandbox","danger-full-access"]'
eq "launched in /data/workdir without /homeassistant" "$(first_cwd)" /data/workdir

reset
mkfake /data/npm/bin/codex "${IMG}"
mkdir -p /data/workdir
options '{"bypass_permissions":false,"extra_args":["--verbose","","--oss"]}'
start_codex
eq "bypass off: extra_args are appended, an empty one is dropped" "$(launch_args)" '["--sandbox","danger-full-access","--verbose","--oss"]'

reset
mkfake /data/npm/bin/codex "${IMG}"
mkdir -p /data/workdir
options '{"bypass_permissions":true,"model":"pins-model","extra_args":["--oss"],"launch_command":"touch /pins/launched"}'
start_codex
yes_ "launch_command replaces the Codex launch" test -e "${P}/launched"
eq "launch_command: the CLI itself is not launched with the default arguments" "$(launch_args)" ""

# --- 3. update-codex ----------------------------------------------------------------
echo "# update-codex"
reset
mkfake /data/npm/bin/codex 1.0.0
out="$(env -i PATH="${BASE_PATH}" /usr/local/bin/update-codex 2>&1)"
eq "no argument: exit 0" "$?" 0
eq "no argument: codex update" "$(codex_calls | tr '\n' ';')" "update;"
no_ "no argument: npm is not called" test -e "${P}/npm.log"
yes_ "no argument: no change is reported" grep -q 'Codex CLI: 1.0.0 (no change)' <<< "${out}"
rm -f "${P}/codex.log" "${P}/codex-args.jsonl"
out="$(env -i PATH="${BASE_PATH}" /usr/local/bin/update-codex 0.1.2 2>&1)"
eq "version: exit 0" "$?" 0
eq "version: npm install --global at the persistent prefix" "$(cat "${P}/npm.log")" \
    "/data/npm|install --global --no-audit --no-fund @openai/codex@0.1.2"
eq "version: codex update is not called" "$(codex_calls | tr '\n' ';')" ""
yes_ "version: the change is reported" grep -q 'Codex CLI: 1.0.0 -> 0.1.2' <<< "${out}"
yes_ "version: the session restart is advised" grep -q 'Restart the Codex session (not the add-on)' <<< "${out}"
rm -f "${P}/codex.log" "${P}/codex-args.jsonl"
touch "${P}/update-fails"
env -i PATH="${BASE_PATH}" /usr/local/bin/update-codex > /dev/null 2>&1
eq "a failing update keeps its exit status" "$?" 3
rm -f "${P}/update-fails"
touch "${P}/npm-fails"
env -i PATH="${BASE_PATH}" /usr/local/bin/update-codex 0.1.3 > /dev/null 2>&1
eq "a failing version install keeps its exit status" "$?" 4
rm -f "${P}/npm-fails" /usr/local/sbin/npm

echo
echo "${pass} passed, ${fail} failed"
[ "${fail}" -eq 0 ]
