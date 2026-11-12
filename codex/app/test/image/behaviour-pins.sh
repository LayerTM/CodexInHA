#!/usr/bin/env bash
# Behaviour pins that only the built image can answer: that nothing bundled
# shadows a system command, what the real CLI sends to the model under a prompt
# API command line, where the Codex CLI the service runs comes from and how a
# shell tab finds it, every branch of the version sync at start-up, the secrets
# guard, provisioning, what the Codex tab launches with, how the CLI is updated,
# how the health check and the morning digest ask a question, and that a prompt
# run leaves no session for agent-usage to count a second time.
#
# Runs as root inside a throwaway container of the add-on image:
#   docker run --rm --network none -v "$PWD/codex/app/test/image:/pins-src:ro" \
#     --entrypoint bash <image> /pins-src/behaviour-pins.sh
#
# Section 0 runs the real CLI against a local stand-in for the model API (nothing
# reaches the network). After it the CLI is replaced by a recording stand-in, so
# nothing else here needs an account either, and the add-on options are served
# to bashio from its own cache directory, which is where bashio looks before it
# asks the Supervisor.
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

# --- 0. the real CLI under a prompt API command line --------------------------
# The command line is the adapter's own, handed to the image's CLI, which talks to
# a local stand-in for the model API. What the CLI then SENDS is the boundary of a
# prompt run: the tools the model is offered, the answer schema, the core's
# instructions, and nothing from a user's own files. A CLI that starts offering a
# shell, a patch tool or the web to this profile fails here, on the pull request
# that moves it, instead of on a device.
mkdir -p /pins/zero-home
node /pins-src/fake-responses-api.js 18555 "${P}/api.log" &
api=$!
sleep 1
/opt/codex-npm/bin/codex features list > "${P}/features.txt" 2>/dev/null
(
    cd /opt/agent-console && node -e '
const fs = require("node:fs");
const cli = require("./adapter/cli.js");
cli.CODEX_BIN = "/opt/codex-npm/bin/codex";
cli.CONSOLE_HOME = "/pins/zero-home/console";
cli.PROMPT_HOME = "/pins/zero-home/prompt";
fs.mkdirSync(cli.CONSOLE_HOME, { recursive: true });
const { launchSpec } = require("./server/prompt/run.js");
const runner = require("./adapter/runner.js");
const { args, env } = runner.launch(launchSpec({}), { env: {} });
// Only the model provider is pointed at the local stand-in.
args.splice(args.length - 1, 0,
  "-c", "model_provider=\"pins\"",
  "-c", "model_providers.pins={name=\"pins\",base_url=\"http://127.0.0.1:18555/v1\",env_key=\"CODEX_API_KEY\",wire_api=\"responses\"}",
  "-c", "model=\"pins-model\"");
const r = require("node:child_process").spawnSync("/opt/codex-npm/bin/codex", args, {
  input: "PINS-QUESTION", encoding: "utf8", timeout: 90000, cwd: "/pins/zero-home",
  env: { PATH: process.env.PATH, HOME: "/pins/zero-home", CODEX_API_KEY: "x", ...env },
});
process.stdout.write(`${r.status}\n${r.stdout || ""}`);
' > "${P}/prompt-run.out" 2> "${P}/prompt-run.err"
)
kill "${api}" 2>/dev/null
wait "${api}" 2>/dev/null
request() { sed -n 2p "${P}/api.log" | jq -r "$1" 2>/dev/null; }
eq "the real CLI answered a prompt run: exit status 0" "$(head -1 "${P}/prompt-run.out")" 0
yes_ "its answer is the model's" grep -q 'pinned answer' "${P}/prompt-run.out"
eq "it made exactly one request to the model" "$(rg -c '^POST ' "${P}/api.log")" 1
eq "the model is offered only these tools" "$(request '[.tools[] | (.name // .type)] | sort | join(",")')" request_user_input
eq "the answer is held to a JSON schema" "$(request '.text.format | [.type, .strict] | join(",")')" json_schema,true
eq "the core's instructions reach the model" "$(request '[.input[] | select(.role == "developer") | .content[].text | contains("Home Assistant bridge")] | any')" true
eq "the request text reaches the model as a user message" \
    "$(request '[.input[] | select(.role == "user") | .content[].text | contains("PINS-QUESTION")] | any')" true
eq "no project instructions file is part of the request" "$(request '[.input[].content[]?.text // empty | contains("# AGENTS.md instructions for")] | any')" false

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
[ "${3:-0}" = 1 ] && exit 127
{ printf '%s|%s|%s|' "\$(readlink -f "\$0")" "\$(pwd)" "\$HOME"; [ \$# -gt 0 ] && printf '%q ' "\$@"; echo; } >> /pins/codex.log
for a in "\$@"; do printf '%s' "\$a" | jq -Rs .; done | jq -cs . >> /pins/codex-args.jsonl
# What is installed lives in /pins/*-list, in the shape the real CLI lists it,
# so provisioning sees what an earlier run added.
case "\$*" in
    --version) echo "codex-cli \${FAKE_VERSION}" ;;
    update) if [ -f /pins/update-fails ]; then echo "update refused" >&2; exit 3; fi; echo "checked for updates" ;;
    "features list") cat /pins/features.txt ;;
    "plugin marketplace list") cat /pins/mp-list 2>/dev/null ;;
    "plugin marketplace add "*) echo "  added (\$4)" >> /pins/mp-list ;;
    "plugin list") cat /pins/plugin-list 2>/dev/null ;;
    "plugin add "*) echo "  \$3" >> /pins/plugin-list ;;
    "mcp list") cat /pins/mcp-list 2>/dev/null ;;
    "mcp add "*) echo "\$3: registered" >> /pins/mcp-list ;;
    exec*)
        # Like the real CLI: the request is stdin, and with none it refuses.
        cat > /pins/codex-stdin.txt
        if [ ! -s /pins/codex-stdin.txt ]; then echo "No prompt provided via stdin." >&2; exit 1; fi
        echo "\${CODEX_HOME:-}" >> /pins/codex-home.log
        if [ -f /pins/log-env ]; then env | cut -d= -f1 | sort | tr '\n' , >> /pins/codex-env.log; echo >> /pins/codex-env.log; fi
        # A run that is not ephemeral keeps its session, as the real CLI does.
        case " \$* " in
            *" --ephemeral "*) ;;
            *)
                dir="\${CODEX_HOME:-\$HOME/.codex}/sessions/2026/09/02"
                mkdir -p "\${dir}"
                printf '%s\\n' '{"timestamp":"2026-09-02T10:00:00Z","type":"turn_context","payload":{"turn_id":"t","model":"gpt-6-astra"}}' \\
                    '{"timestamp":"2026-09-02T10:00:01Z","type":"token_usage_record","payload":{"turn_id":"t","usage":{"input_tokens":5,"output_tokens":6}}}' \\
                    >> "\${dir}/rollout-run.jsonl" ;;
        esac
        [ -f /pins/codex-silent ] || printf '%s\\n' '{"type":"item.completed","item":{"id":"i","type":"agent_message","text":"Good morning from the pins"}}'
        printf '%s\\n' '{"type":"turn.completed","usage":{"input_tokens":1,"output_tokens":1}}' ;;
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
    rm -rf /data /homeassistant /pins/monitor-data
    rm -f "${P}"/codex.log "${P}"/codex-args.jsonl "${P}"/npm.log "${P}"/console-* "${P}"/update-fails \
        "${P}"/npm-fails "${P}"/launched "${P}"/run.out "${P}"/start.out "${P}"/mp-list "${P}"/plugin-list \
        "${P}"/mcp-list "${P}"/codex-stdin.txt "${P}"/codex-home.log "${P}"/codex-env.log "${P}"/log-env \
        "${P}"/codex-silent "${P}"/notify.log "${P}"/curl.log "${P}"/curl-stdin.log "${P}"/digest.err "${P}"/monitor.err
    mkdir -p /data
}

envv() { jq -r --arg k "$1" 'if has($k) then .[$k] else "<unset>" end' "${P}/console-env.json"; }
persistent_version() { /data/npm/bin/codex --version 2>/dev/null | awk '{print $2}'; }
# Every call of the stand-in except the version probes the launchers make.
codex_calls() { cut -d'|' -f4- "${P}/codex.log" 2>/dev/null | grep -v -- '^--version' | sed 's/ $//'; }
# The console's launch: every call except the version probes and the background
# service match that the launcher makes before it (codex-daemon.sh).
launch_args() {
    jq -c . "${P}/codex-args.jsonl" 2>/dev/null \
        | grep -v -e '^\["--version"\]$' -e '^\["app-server","daemon","update","--from-cli","--yes"\]$' | head -1
}

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
yes_ "the replacement is reported" grep -q 'The image has a newer Codex CLI' "${P}/run.out"

echo "# service script: update fails, CLI does not run, image CLI unreadable"
reset
mkfake /data/npm/bin/codex 1.0.0
touch "${P}/update-fails"
options '{"auto_update":true}'
run_service
eq "a failed update does not stop the start" "$?" 0
eq "an older persistent CLI is replaced even when the update fails" "$(persistent_version)" "${IMG}"
yes_ "the failed update is reported" grep -q 'Update check failed (non-critical)' "${P}/run.out"
rm -f "${P}/update-fails"

reset
mkfake /data/npm/bin/codex 9.0.0 1
mkdir -p /data/codex
echo keep-me > /data/codex/auth.json
options '{"auto_update":false}'
run_service
eq "a stored CLI that does not run: the start goes on" "$?" 0
eq "it is reinstalled from the image" "$(persistent_version)" "${IMG}"
yes_ "the reinstall is reported" grep -q 'does not run on this image' "${P}/run.out"
eq "the login survives the reinstall" "$(cat /data/codex/auth.json)" keep-me

reset
mkfake /data/npm/bin/codex "${IMG}"
options '{"auto_update":false}'
run_service
yes_ "equal versions: the version is reported" grep -q "Codex CLI version: ${IMG}" "${P}/run.out"
no_ "equal versions: nothing is copied" grep -q 'copying it into persistent storage' "${P}/run.out"

reset
mkfake /data/npm/bin/codex 9.0.0
mkfake /opt/codex-npm/bin/codex "${IMG}" 1
options '{"auto_update":false}'
run_service
eq "image CLI unreadable: the start goes on" "$?" 0
yes_ "image CLI unreadable: the sync is skipped with a warning" grep -q 'Could not determine the Codex CLI version for the image sync' "${P}/run.out"
eq "image CLI unreadable: the stored CLI is kept" "$(persistent_version)" 9.0.0
mkfake /opt/codex-npm/bin/codex "${IMG}"
rm -f /usr/local/sbin/node

# --- secrets guard, on the host this runs on ------------------------------------
echo "# secrets-guard: protect_secrets on (the default)"
# A plain docker run is never under the app's own AppArmor profile: on an
# AppArmor host it gets the runtime's (docker-default), elsewhere none. Both
# must start the app with only the command check, and say so.
reset
options '{}'
kernel="" label=""
read -r kernel </sys/module/apparmor/parameters/enabled 2>/dev/null || true
read -r label </proc/self/attr/current 2>/dev/null || true
env -i PATH="${BASE_PATH}" timeout 20 /usr/local/bin/secrets-guard /usr/bin/env > "${P}/guard.out" 2>&1
status=$?
if [ "${kernel}" = Y ]; then host="AppArmor host, label ${label% (*}"; else host="host without AppArmor"; fi
eq "${host}: the service starts" "${status}" 0
yes_ "${host}: only the command check is on" grep -qx 'PROTECT_SECRETS_LEVEL=cli-only' "${P}/guard.out"
yes_ "${host}: the log says so" grep -qE 'WARNING.*cli-only' "${P}/guard.out"
eq "${host}: the level is recorded for the hook" "$(cat /run/secrets-guard-level 2>/dev/null)" cli-only
options '{"protect_secrets":false}'
env -i PATH="${BASE_PATH}" timeout 20 /usr/local/bin/secrets-guard /usr/bin/env > "${P}/guard.out" 2>&1
eq "turned off after a start with it on: the service starts" "$?" 0
yes_ "the drop from cli-only to off is announced" grep -qx 'PROTECT_SECRETS_DROPPED=cli-only off' "${P}/guard.out"
eq "off is recorded for the hook" "$(cat /run/secrets-guard-level 2>/dev/null)" off
rm -f /run/secrets-guard-level

# --- 2. the Codex tab (start-codex) ----------------------------------------------
# start_codex: the launcher loops forever (restart menu); its first calls are the pin.
# The launcher is given as long as it needs (an emulated architecture is slow):
# it is over when it shows its menu, which it does after every launch, and is
# stopped there.
start_codex() {
    env -i PATH="${BASE_PATH}" HOME=/root bashio /usr/local/bin/start-codex < /dev/null > "${P}/start.out" 2>&1 &
    local pid=$! waited=0
    while [ "${waited}" -lt 600 ] && ! grep -q 'Codex exited' "${P}/start.out" 2>/dev/null; do
        sleep 0.2
        waited=$((waited + 1))
    done
    kill "${pid}" 2>/dev/null
    wait "${pid}" 2>/dev/null
    return 0
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
eq "the background service is matched to the CLI before the launch" \
    "$(codex_calls | head -2 | awk 'NR == 1 {print; next} {print $1}' | tr '\n' ';')" \
    "app-server daemon update --from-cli --yes;--dangerously-bypass-approvals-and-sandbox;"
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
# Both together: the command ran (a launcher that crashed leaves no file), and the
# CLI was not launched in its place (a crash alone would also leave no call).
yes_ "launch_command replaces the Codex launch: the command ran" test -e "${P}/launched"
eq "launch_command replaces the Codex launch: the CLI itself is not launched" "$(launch_args)" ""
yes_ "launch_command: the launcher reached its menu" grep -q 'Codex exited' "${P}/start.out"

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

# --- 4. provisioning, run on its own -----------------------------------------------
echo "# provision-extras"
provision() {
    env -i PATH="${BASE_PATH}" HOME=/root HA_TOKEN="${HA_TOKEN_IN:-}" HA_URL=http://homeassistant:8123 \
        CC_USER_MARKETPLACES="${MP_IN:-}" CC_USER_PLUGINS="${PL_IN:-}" CC_SKILLS_GIT="${GIT_IN:-}" \
        /usr/local/bin/provision-extras > "${P}/provision.out" 2>&1
}
changes() { codex_calls | grep -E '^(plugin marketplace add|plugin add|mcp add) ' | cut -d' ' -f1-4 | tr '\n' ';'; }
lists() { codex_calls | grep -E '^(plugin marketplace list|plugin list|mcp list)$' | tr '\n' ';'; }

reset
mkfake /data/npm/bin/codex "${IMG}"
HA_TOKEN_IN=EXAMPLE-ha-provision provision
eq "first run registers the browser server and, with a token, the Home Assistant one" "$(changes)" \
    "mcp add playwright --;mcp add hass-mcp --env;"
yes_ "first run completes" grep -q 'provisioning complete' "${P}/provision.out"
yes_ "the Home Assistant skill pack is synced into the CLI's skills" test -f /data/codex/skills/ha-automation/SKILL.md
yes_ "the registered hass-mcp carries the Home Assistant address and token" \
    grep -qF 'mcp add hass-mcp --env HA_URL=http://homeassistant:8123 --env HA_TOKEN=EXAMPLE-ha-provision -- hass-mcp' "${P}/codex.log"
rm -f "${P}/codex.log"
HA_TOKEN_IN=EXAMPLE-ha-provision provision
eq "second run changes nothing" "$(changes)" ""
yes_ "second run completes" grep -q 'provisioning complete' "${P}/provision.out"

rm -f "${P}/codex.log"
MP_IN='owner/market' PL_IN='extra@market' HA_TOKEN_IN=EXAMPLE-ha-provision provision
eq "a user marketplace and plugin are added, once" "$(changes)" "plugin marketplace add owner/market;plugin add extra@market;"
rm -f "${P}/codex.log"
MP_IN='owner/market' PL_IN='extra@market' HA_TOKEN_IN=EXAMPLE-ha-provision provision
eq "and not again" "$(changes)" ""

reset
mkfake /data/npm/bin/codex "${IMG}"
provision
no_ "no HA token: hass-mcp is not registered" grep -q 'mcp add hass-mcp' "${P}/codex.log"

reset
mkfake /data/npm/bin/codex "${IMG}"
mkdir -p /data/codex
flock /data/codex/.provision.lock sleep 4 &
locker=$!
sleep 0.5
provision
wait "${locker}"
yes_ "a second concurrent run skips" grep -q 'provisioning already running' "${P}/provision.out"
no_ "a skipped run calls nothing" test -s "${P}/codex.log"

reset
mkfake /data/npm/bin/codex "${IMG}"
mkdir -p /data/codex/skills/ha-automation /data/codex/skills/mine
echo edited > /data/codex/skills/ha-automation/SKILL.md
echo my-own > /data/codex/skills/mine/SKILL.md
provision
yes_ "a bundled skill edited in place is restored" cmp -s /data/codex/skills/ha-automation/SKILL.md /opt/ha-skills/ha-automation/SKILL.md
eq "a skill of the user's own is left alone" "$(cat /data/codex/skills/mine/SKILL.md)" my-own

repo=/pins/skills-repo
rm -rf "${repo:?}"
mkdir -p "${repo}/alpha" "${repo}/notes"
echo alpha-v1 > "${repo}/alpha/SKILL.md"
echo not-a-skill > "${repo}/notes/README.md"
gitc() { git -C "${repo}" -c user.name=pins -c user.email=pins@localhost "$@" > /dev/null 2>&1; }
git init -q "${repo}"
gitc add -A
gitc commit -qm one
GIT_IN="${repo}" provision
yes_ "skills_git: cloned" grep -q 'skills_git cloned' "${P}/provision.out"
eq "skills_git: a directory with SKILL.md becomes a skill" "$(cat /data/codex/skills/alpha/SKILL.md 2>/dev/null)" alpha-v1
no_ "skills_git: a directory without SKILL.md does not" test -e /data/codex/skills/notes
echo alpha-v2 > "${repo}/alpha/SKILL.md"
gitc commit -qam two
GIT_IN="${repo}" provision
yes_ "skills_git: pulled on the next run" grep -q 'skills_git pulled' "${P}/provision.out"
eq "skills_git: the skill follows the repository" "$(cat /data/codex/skills/alpha/SKILL.md)" alpha-v2
gitc rm -rq alpha
gitc commit -qm three
GIT_IN="${repo}" provision
no_ "skills_git: a skill removed from the repository is removed" test -e /data/codex/skills/alpha
yes_ "skills_git: the removal is logged" grep -q 'skills_git: removed alpha' "${P}/provision.out"
eq "skills_git: a skill of the user's own stays" "$(cat /data/codex/skills/mine/SKILL.md 2>/dev/null)" my-own

# --- 5. agent-ask, the health check and the morning digest ---------------------------
# Both loops are the core's; they ask the engine's agent-ask. What reaches Codex is
# the restricted profile with the prompt on stdin, and no Supervisor or Home
# Assistant credential in its environment.
echo "# agent-ask"
ask_fakes() {
    local bin=/pins/bin
    rm -rf "${bin:?}"
    mkdir -p "${bin}"
    mkfake /data/npm/bin/codex "${IMG}"
    cat > "${bin}/curl" <<'EOF'
#!/bin/bash
printf '%q ' "$@" >> /pins/curl.log; echo >> /pins/curl.log
cat >> /pins/curl-stdin.log
case "$*" in
    *core/api/states*)
        echo '[{"entity_id":"weather.home","state":"sunny","attributes":{"friendly_name":"Pins Weather","temperature":21}},
{"entity_id":"light.hall","state":"on","attributes":{"friendly_name":"Pins Hall"}}]' ;;
    *)
        printf '2026-09-16 18:19:00.001 ERROR (MainThread) [homeassistant.components.pins] Setup failed: PINS-LOG-MARK\n200' ;;
esac
EOF
    printf '#!/bin/bash\necho "Configuration valid"\n' > "${bin}/check"
    printf '#!/bin/bash\nprintf "%%s\\n" "$1|$2" >> /pins/notify.log\n' > "${bin}/notify"
    chmod +x "${bin}/curl" "${bin}/check" "${bin}/notify"
}
# The names the core never lets reach an engine child (the Supervisor and Home
# Assistant credentials and addresses), read from the core this image ships:
# its own FORBIDDEN_ENV in server/prompt/run.js, evaluated in that module, so
# this file never types the list and cannot fall behind it. If the core renames
# or drops the set, reading it fails and so does every check below.
core_forbidden_env() {
    node -e '
const Module = require("node:module");
const file = "/opt/agent-console/server/prompt/run.js";
const m = new Module(file, null);
m.filename = file;
m.paths = Module._nodeModulePaths(require("node:path").dirname(file));
m._compile(`${require("node:fs").readFileSync(file, "utf8")}\nmodule.exports.__forbiddenEnv = [...FORBIDDEN_ENV];`, file);
const names = m.exports.__forbiddenEnv;
if (!Array.isArray(names) || names.length === 0) process.exit(1);
process.stdout.write(names.join("\n") + "\n");'
}
forbidden_env=()
while IFS= read -r name; do forbidden_env+=("${name}"); done < <(core_forbidden_env)
yes_ "the core's list of names kept from engine children was read" test "${#forbidden_env[@]}" -gt 0
# The loops' own environment when addon-run starts them: every one of those names set.
loop_env=(env -i PATH="${BASE_PATH}" HOME=/root)
for name in "${forbidden_env[@]}"; do loop_env+=("${name}=EXAMPLE-${name}"); done
# The names of the core's list that reached the CLI, from the recorded environment.
leaked_env() {
    local name leaked=""
    for name in "${forbidden_env[@]}"; do
        if grep -qE "(^|,)${name}(,|\$)" "${P}/codex-env.log"; then leaked="${leaked}${name} "; fi
    done
    printf '%s' "${leaked}"
}
run_digest() {
    "${loop_env[@]}" CC_DIGEST_CURL=/pins/bin/curl CC_DIGEST_NOTIFY_CMD=/pins/bin/notify \
        timeout 120 /usr/local/bin/cc-digest --once > /dev/null 2> "${P}/digest.err" < /dev/null
}
run_monitor() {
    mkdir -p /pins/monitor-data
    "${loop_env[@]}" CC_MONITOR_CURL=/pins/bin/curl CC_MONITOR_CHECK_CMD=/pins/bin/check \
        CC_MONITOR_NOTIFY_CMD=/pins/bin/notify CC_MONITOR_DATA_DIR=/pins/monitor-data CLAUDE_MONITOR_HOURS=1 \
        timeout 120 /usr/local/bin/cc-monitor --once > /dev/null 2> "${P}/monitor.err" < /dev/null
}
# The one-shot question's command line, as it was recorded: the restricted
# profile (the full list is proven by the argument smoke), with this shape.
ask_shape() {
    jq -c 'select(.[0] == "exec") | [.[0], (index("--ephemeral") != null), (.[index("--sandbox") + 1]),
        (index("--output-schema") == null), (map(startswith("mcp_servers.")) | any | not), .[-1]]' \
        "${P}/codex-args.jsonl" | head -1
}
ASK_SHAPE='["exec",true,"read-only",true,true,"-"]'

reset
ask_fakes
/opt/codex-npm/bin/codex features list > /dev/null 2>&1 || true
out="$(printf 'PINS-QUESTION' | env -i PATH="${BASE_PATH}" HOME=/root /usr/local/bin/agent-ask 2>"${P}/ask.err")"
eq "agent-ask: exit 0 with an answer" "$?" 0
eq "agent-ask: the answer is the agent's last message" "${out}" "Good morning from the pins"
eq "agent-ask: Codex is called with the restricted one-shot profile" "$(ask_shape)" "${ASK_SHAPE}"
eq "agent-ask: the question goes in on stdin" "$(cat "${P}/codex-stdin.txt")" PINS-QUESTION
eq "agent-ask: it runs the persistent CLI" "$(jq -rs 'map(.) | length > 0' "${P}/codex-args.jsonl")" true
eq "agent-ask: with the prompt home, never the console's" "$(cat "${P}/codex-home.log")" /data/codex-prompt
reset
ask_fakes
printf '' | env -i PATH="${BASE_PATH}" HOME=/root /usr/local/bin/agent-ask > /dev/null 2>&1
eq "agent-ask: no question: it refuses and fails" "$?" 1
reset
ask_fakes
touch "${P}/codex-silent"
printf 'PINS-QUESTION' | env -i PATH="${BASE_PATH}" HOME=/root /usr/local/bin/agent-ask > /dev/null 2>&1
eq "agent-ask: an agent that answers nothing fails" "$?" 1

echo "# cc-digest"
reset
ask_fakes
touch "${P}/log-env"
run_digest
eq "digest: states are fetched from the Supervisor, no credential in argv" "$(head -1 "${P}/curl.log")" \
    "-K - -sS http://supervisor/core/api/states "
eq "digest: the Supervisor bearer travels on stdin, not argv" "$(cat "${P}/curl-stdin.log")" \
    'header = "Authorization: Bearer EXAMPLE-SUPERVISOR_TOKEN"'
eq "digest: Codex is called with the restricted one-shot profile" "$(ask_shape)" "${ASK_SHAPE}"
yes_ "digest: the prompt goes in on stdin and carries the snapshot as data" \
    bash -c 'grep -q "====HOME SNAPSHOT====" /pins/codex-stdin.txt && grep -q "Pins Weather" /pins/codex-stdin.txt'
yes_ "digest: the CLI's environment was recorded" test -s "${P}/codex-env.log"
eq "digest: none of the core's kept-back names in the CLI's environment" "$(leaked_env)" ""
eq "digest: the answer is pushed with its title" "$(cat "${P}/notify.log")" "Good morning from the pins|Codex · Morning briefing"

reset
ask_fakes
touch "${P}/codex-silent"
run_digest
no_ "digest: an empty answer is not pushed" test -s "${P}/notify.log"
yes_ "digest: an empty answer is logged" grep -q "^\[cc-digest\] the briefing produced nothing" "${P}/digest.err"

echo "# cc-monitor"
reset
ask_fakes
touch "${P}/log-env"
run_monitor
eq "monitor: Codex is called with the restricted one-shot profile" "$(ask_shape)" "${ASK_SHAPE}"
yes_ "monitor: the prompt goes in on stdin and carries the log as data" grep -q PINS-LOG-MARK "${P}/codex-stdin.txt"
yes_ "monitor: the CLI's environment was recorded" test -s "${P}/codex-env.log"
eq "monitor: none of the core's kept-back names in the CLI's environment" "$(leaked_env)" ""
eq "monitor: a finding is pushed with its title" "$(cat "${P}/notify.log")" "Good morning from the pins|Codex · HA health check"

# The one-shot question itself, whatever its caller passes: the loops above
# already strip their credentials, so this asks agent-ask directly with every
# name of the core's list set, and none may reach the CLI.
echo "# agent-ask"
reset
ask_fakes
touch "${P}/log-env"
printf 'PINS-QUESTION\n' | "${loop_env[@]}" /usr/local/bin/agent-ask > "${P}/ask.out" 2> "${P}/ask.err"
eq "one-shot: the question is answered" "$(cat "${P}/ask.out")" "Good morning from the pins"
yes_ "one-shot: the CLI's environment was recorded" test -s "${P}/codex-env.log"
eq "one-shot: none of the core's kept-back names reach the CLI from its caller" "$(leaked_env)" ""

# --- 6. a prompt API run is not counted twice ----------------------------------------
# The core counts prompt runs from its audit log; agent-usage counts the console's
# session files. A run must therefore leave no session file: what agent-usage
# prints is the same before and after one, and the check can see a run that does.
echo "# agent-usage and prompt runs"
reset
ask_fakes
mkdir -p /data/codex/sessions/2026/09/01
printf '%s\n' '{"timestamp":"2026-09-01T10:00:00Z","type":"turn_context","payload":{"turn_id":"c","model":"gpt-6-astra"}}' \
    '{"timestamp":"2026-09-01T10:00:01Z","type":"token_usage_record","payload":{"turn_id":"c","usage":{"input_tokens":3,"output_tokens":4}}}' \
    > /data/codex/sessions/2026/09/01/rollout-console.jsonl
# The same CLI, reached through a wrapper that drops the flag.
cat > "${P}/prompt-cli-leaky" <<'EOF'
#!/bin/bash
args=()
for a in "$@"; do [ "${a}" = --ephemeral ] || args+=("${a}"); done
exec /data/npm/bin/codex "${args[@]}"
EOF
chmod +x "${P}/prompt-cli-leaky"
cat > "${P}/prompt-run.js" <<'EOF'
const { run } = require('/opt/agent-console/server/prompt/run');
run({ bin: process.argv[2], cwd: '/data/codex-prompt', prompt: 'hello', mode: 'read', intents: [] })
  .then((outcome) => console.log(JSON.stringify(outcome)));
EOF
# agent-usage speaks the core's incremental --files/--parse protocol, not a bare
# dump; this drives it as the core's ha-usage would, one S/L.../E round per file,
# and prints every record found, sorted for a stable comparison.
cat > "${P}/usage-record.py" <<'PYEOF'
import json
import subprocess

paths = [p for p in subprocess.run(
    ['/usr/local/bin/agent-usage', '--files'], capture_output=True, check=True,
).stdout.decode().split('\0') if p]
proc = subprocess.Popen(['/usr/local/bin/agent-usage', '--parse'], stdin=subprocess.PIPE, stdout=subprocess.PIPE)
records = []
for i, path in enumerate(paths):
    with open(path, encoding='utf-8') as fh:
        lines = fh.read().splitlines()
    payload = [json.dumps(['S', str(i), None])] + [json.dumps(['L', line]) for line in lines] + [json.dumps(['E', str(i)])]
    proc.stdin.write(('\n'.join(payload) + '\n').encode())
    proc.stdin.flush()
    proc.stdout.readline()  # S ack (null)
    for _ in lines:
        records.extend(json.loads(proc.stdout.readline()))
    proc.stdout.readline()  # E ack ({"state": ...})
proc.stdin.close()
proc.wait()
print(json.dumps(records, sort_keys=True))
PYEOF
usage_record() {
    local out status
    out="$(env -i PATH="${BASE_PATH}" CODEX_HOME=/data/codex python3 "${P}/usage-record.py")"
    status=$?
    printf '%s\nexit %s\n' "${out}" "${status}"
}
session_files() { { ls /data/codex/sessions/*/*/*/* /data/codex-prompt/sessions/*/*/*/*; } 2>/dev/null | wc -l; }
prompt_run() {
    (cd /opt/agent-console && env -i PATH="${BASE_PATH}" HOME=/root timeout 120 /usr/local/bin/node "${P}/prompt-run.js" "$1" > "${P}/prompt-run.out" 2>&1)
}
before="$(usage_record)"
eq "agent-usage reads the console's session" "$(head -1 <<< "${before}" | jq -c 'map([.input, .output, .model]) ')" '[[3,4,"gpt-6-astra"]]'
eq "one session file exists before a run" "$(session_files)" 1
prompt_run /data/npm/bin/codex
yes_ "a prompt run reached the CLI" test -s "${P}/codex-home.log"
eq "a prompt run leaves no session file in either home" "$(session_files)" 1
eq "agent-usage is unchanged by a prompt run" "$(usage_record)" "${before}"
prompt_run "${P}/prompt-cli-leaky"
eq "a run that drops --ephemeral leaves a session file" "$(session_files)" 2

echo
echo "${pass} passed, ${fail} failed"
[ "${fail}" -eq 0 ]
