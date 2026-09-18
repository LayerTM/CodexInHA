# Codex — Home Assistant Add-on

Runs the full [Codex CLI](https://github.com/openai/codex) inside Home Assistant, presented as a web console you open from the add-on page — or from the sidebar, once you put it there (step 3 below). Codex has direct access to your HA configuration and APIs: it can create automations, debug integrations, run shell commands, and manage your setup through conversation.

## Installation

1. **Settings → Add-ons → Add-on Store** → ⋮ → **Repositories** → add
   `https://github.com/LayerTM/CodexInHA`
2. Install **Codex** and start it.
3. Open it with **Open Web UI** on the add-on page. For a **Codex** entry in the
   sidebar, turn on **Show in sidebar** there: Home Assistant leaves that switch
   off for every add-on it installs, whatever the add-on asks for, so the panel
   appears only once you turn it on.

## Authentication (pick one)

| Method | How |
|---|---|
| **ChatGPT plan (recommended)** | Leave **API Key** empty, open the console, run `codex login` and follow the login URL. The login persists across restarts. |
| **API key** | Paste a key from [platform.openai.com](https://platform.openai.com) into **API Key**. Pay-per-use. |

## The console

- **Tabs** — ● Codex plus any number of shell tabs (+). Exiting Codex shows a restart menu; the session never dies with it.
- **Copy** — hold a modifier and drag to select, and it copies automatically: **Option+drag on macOS**, **Shift+drag on Windows/Linux/ChromeOS** (a real terminal selection). Or press **Cmd+C** / **Ctrl+Shift+C** / **Ctrl+Insert** for the current selection (plain Ctrl+C still interrupts the running program; Ctrl+Insert is the safest on desktop Chrome, where Ctrl+Shift+C also opens DevTools). A wrapped line copies as one line, and it works even over plain HTTP. Without the modifier, a drag goes through tmux and lands in the 📥 tray instead. The ⧉ menu copies the visible screen / recent output / full history without selecting — **this is the copy path on phones**, where text selection isn't available. If the browser blocks clipboard access entirely, copies land in the 📥 tray — tap an entry to copy it. The mouse **wheel scrolls** the history.
- **Paste** — Ctrl+Shift+V / Cmd+V, or the 📋 button. Multi-line text pastes as a single block (bracketed paste), so it lands as one prompt instead of sending line-by-line.
- **Multi-line prompt** — **Shift+Enter** adds a new line without sending (so does **Option/Alt+Enter** and **Ctrl+Enter**); plain **Enter** sends. On phones, the **⇧⏎** key on the key bar inserts a line break.
- **Find** — Cmd+F (macOS) or Ctrl+Shift+F, or the 🔍 button, opens a search bar to find text anywhere in the scrollback; Enter / Shift+Enter step through matches, Esc closes it. On phones, tap 🔍 on the key bar. (Plain Ctrl+F is left for the shell/TUI — it's forward-char in the shell and page-forward in less/vim.)
- **Quick prompts** — the 💡 button drops down a few ready-made prompts (*What changed today?*, *Check my dashboard*, *Check config health*, *Offline / low battery?*, *Recent log errors*). Tapping one inserts the prompt into the console for you to review and send with Enter — nothing runs automatically. Add your own with the `quick_prompts` option — they appear under *Your prompts* in the same menu.
- **Alerts & notifications** — the 🔔 button shows whether proactive alerts are on, any currently-active alerts (leak / low battery / door open at night, with criticals in red), and the messages in your Home Assistant notification bell. Read-only. A badge on the 🔔 shows how many alerts are currently active at a glance (red if any is critical), so you don't have to open the menu to notice.
- **Attach files & images** — drag & drop anywhere, paste an image from the clipboard, or use 📎 (opens camera/gallery on phones). The file is saved under `/data/uploads` and its path is typed into the prompt.
- **Update Codex** — ⬆ button, or `update-codex` in a shell tab (`update-codex 0.155.0` installs a specific version). Only the Codex session restarts; the add-on keeps running. With **Auto-Update** enabled the CLI also updates at every add-on start.
- **Remote control** — with the **Remote Control** option on, an extra tab runs Codex's own remote-control command, so the official ChatGPT mobile app / chatgpt.com can drive this machine's session. Requires a full `codex login` — an API key is not enough.
- **Mobile** — a key bar (Esc, Tab, arrows, ^C…) appears on touch devices; ⛶ hides the HA chrome for a full-screen terminal.

## Home Assistant tooling (built in)

Everything Codex needs to work with Home Assistant is preinstalled — no
per-session setup:

| Tool | Use |
|---|---|
| `ha` | Supervisor CLI: `ha core check`, `ha core reload`, `ha addons`, `ha backups new --name X` |
| `ha-check` | Validate the HA configuration (run before any restart) |
| `ha-state [entity\|domain.]` | Query entity states, e.g. `ha-state light.kitchen`, `ha-state light.` |
| `ha-shot <path> [out.png] [WxH]` | Screenshot a Lovelace dashboard to PNG, e.g. `ha-shot /lovelace/0 /tmp/d.png 1280x800` (needs **HA Token**) |
| `ha-usage [days]` | Summarize Codex token usage (today / N days / all-time, per model) from the console's session history. This add-on reports no cost, so the figures are token counts, never a dollar amount |
| `ha-audit [N]` | Show what Codex has changed: service calls, edits under your config, Core restarts, safety backups, and every change made through a connected tool server (dashboard edits included). Reads are not recorded; a preview is marked `(dry-run)` and a call that failed is marked `(failed)` |
| `yq` | Edit YAML config files |
| `hass-cli` | Entity/service queries (needs **HA Token**) |
| Playwright MCP | Browser automation tools; Chromium is preinstalled |

A **Home Assistant skill pack** is bundled: `ha-config-edit`, `ha-automation`,
`ha-debug`, `ha-entity`, `ha-screenshot`, `ha-backup`, `ha-addon`, `ha-onboard`,
`ha-energy`, `ha-recorder-query`, `ha-lovelace-card`, `ha-blueprint`,
`ha-voice`. Everything installed lives in `/data/codex` and **persists across
add-on updates**.

Add your own with the `plugins`, `marketplaces`, and `skills_git` options —
reconciled on every start.

## Configuration options

| Option | Purpose |
|---|---|
| `api_key` | API-key authentication (see above). Stored encrypted by the Supervisor. |
| `ha_token` | A Home Assistant Long-Lived Access Token (Profile → Security). Enables dashboard screenshots, `hass-cli`, `hass-mcp` — including its tools for reading **and editing** Lovelace dashboards — and WebSocket/REST access as you. Persists across updates. Optional. |
| `bypass_permissions` | Start Codex with `--dangerously-bypass-approvals-and-sandbox` (fully autonomous): it stops asking you to approve what it does. The console runs unsandboxed either way — it is your own session, and the boundary around it is the add-on container. This option decides the approval prompts. The prompt API is a different thing entirely: it always runs read-only (see below). |
| `auto_update` | Update the CLI at every add-on start. Manual `update-codex` always works. |
| `model` | Model override. Leave empty for the Codex CLI default. |
| `custom_instructions` | Text appended to the built-in HA context (`AGENTS.md`). |
| `environment_vars` | Extra env vars, `KEY=VALUE` per entry. |
| `init_commands` | Shell commands run at startup (install tools, MCP servers). |
| `plugins` | Extra plugins to install, one per entry. |
| `marketplaces` | Extra plugin marketplaces (GitHub `owner/repo`, URL, or path). |
| `skills_git` | Git repo of your own skills, synced into `/data/codex/skills` each start. |
| `extra_args` | Extra `codex` CLI arguments, one per entry. |
| `launch_command` | Full replacement for the default `codex` invocation. |
| `quick_prompts` | Your own prompts for the 💡 menu — a list of strings. Each becomes a button that *inserts* the text (never auto-runs), shown under *Your prompts*. |
| `upload_retention_days` | Auto-delete attached files after N days (0 = keep). |
| `transcript_retention_days` | Auto-delete console session transcripts older than N days (0 = keep). |
| `remote_control` | Adds a tab running Codex's own remote-control command: drive this session from the ChatGPT mobile app / chatgpt.com. Requires a full `codex login`; an API key is not sufficient. It runs in the same folder as the Codex tab, so accept Codex's trust prompt there once first. |
| `monitoring_interval_hours` | Opt-in proactive monitoring: every N hours Codex reviews the error log and config and notifies you only if it finds something (0 = off). |
| `proactive_alerts` + `alert_*` | Opt-in **deterministic** anomaly alerts (no Codex, no plan usage): notify on a water leak, door/window open at night, low battery, temperature out of band, high CO2, humidity out of band, or a watched device/internet gateway going offline. See *Proactive alerts* below. |
| `prompt_api` | Serve the secure Prompt API for the companion **AI Agent** (`claude_ha`) integration (on by default). See *The companion integration* below. |
| `api_token` | Optional fixed bearer token for the Prompt API. Leave empty — the add-on generates one and hands it to the integration via discovery. |
| `prompt_ha_token` | Optional HA token used only by Prompt-API sessions to read state through the MCP Server integration. Best practice: a dedicated non-admin user's token. Falls back to `ha_token`. |

This add-on reports no cost for any run (the CLI does not report a dollar
figure), so there is no daily chat budget option and `/api/status` publishes
no `budget`.

## Codex in Home Assistant

Codex works in `/homeassistant` (your config) with `/share`, `/media`, `/ssl`, `/backup` mounted. The Supervisor API is available via `$SUPERVISOR_TOKEN`:

```bash
curl -sS -H "Authorization: Bearer $SUPERVISOR_TOKEN" \
  http://supervisor/core/api/states | jq '.[].entity_id'
```

The bundled `AGENTS.md` teaches Codex the HA API, config patterns, and safety rules (validate config before restart, prefer reloads, and so on).

MCP servers are configured in `config.toml` under `CODEX_HOME` (`/data/codex/config.toml`), skills live under `/data/codex/skills/`, and plugins are managed through the `plugins` and `marketplaces` options.

## Proactive alerts

Set `proactive_alerts: true` for opt-in, **deterministic** anomaly alerts. Unlike
proactive monitoring (`monitoring_interval_hours`) and the morning digest, this
uses **no Codex call and no plan usage** — it is a small bash + jq loop that
fetches your Home Assistant states every `proactive_alerts_interval_minutes`
(default 15) and applies fixed rules. Because there is no model, there is no
prompt-injection surface.

It watches for:

- **Water leak** (`alert_water_leak`, on) — any `moisture`/leak sensor turning on. **Critical**: always sent, even during quiet hours.
- **Open at night** (`alert_open_at_night`, on) — a door, window, garage, or opening left `on` during the night window (`alert_night_start`–`alert_night_end`, default 23:00–06:00).
- **Low battery** (`alert_battery_below`, default 15%; 0 = off) — any `battery` entity below the threshold.
- **Temperature out of band** (`alert_temp_enabled`, off by default) — a `temperature` sensor below `alert_temp_low` (5) or above `alert_temp_high` (45). Off by default because sensible bands vary. By default it checks **every** `temperature` sensor — including device temperatures (a NAS or switch CPU running at 45–75°), which would false-trigger. Set `alert_temp_entities` to a list of just your **room** temperature sensors to scope the check to those (see below).
- **High CO2** (`alert_co2_above`, default 1400 ppm; 0 = off) — any `carbon_dioxide` sensor reading above the threshold, so you know when a room needs airing out. Non-critical (held back during quiet hours).
- **Humidity out of band** (`alert_humidity_enabled`, off by default) — a `humidity` sensor below `alert_humidity_low` (25%) or above `alert_humidity_high` (70%), so you catch a damp bathroom/cellar or over-dry room. Non-critical (held back during quiet hours).
- **Offline / network** (`alert_offline`, on) — any entity you list in `alert_offline_entities` that reports `unavailable`/`unknown`, or (for a `device_tracker`) `not_home`. **Critical**: always sent, even during quiet hours. The list starts **empty**, so this check watches nothing until you name an entity — add your internet gateway's `device_tracker` to be told when the connection drops.

**Dedupe:** you are notified only when an entity *newly* enters an anomaly. A
still-open door won't re-notify every cycle — the active anomalies are remembered
in `/data/alerts-state.json` and dropped when they clear, so the same entity can
alert again the next time the problem reappears. Turning `proactive_alerts` off clears this
memory when the add-on next starts, so anything still wrong when you switch alerts
back on is notified again.

**Quiet hours** (`alert_quiet_hours`, e.g. `22:00-07:00`, empty = off): during
this window non-critical alerts (battery, temperature, open-at-night, high CO2)
are held back and stay pending until quiet hours end; critical alerts — water
leak and a watched device going offline — are **always** sent.

All new anomalies from one cycle are batched into a single notification titled
*Codex · Home alert*. As with the monitor and digest, set `HA_NOTIFY_SERVICE`
in Environment Variables to push to your phone; otherwise it lands in the HA
notification bell. Activity is logged to `/data/alerts.log`.

### Adding, changing, or removing an alert

Every alert is just an option you set in the add-on's **Configuration** tab — no
automations and no code. Because the whole feature is deterministic (fixed bash +
jq rules, no model), it costs **nothing in plan usage** and has **no
prompt-injection surface**. First turn the feature on with `proactive_alerts:
true`, then enable, disable, or tune each check:

| Alert | Option(s) | Turn off | Tune |
|-------|-----------|----------|------|
| Water leak | `alert_water_leak` | `false` | — (critical, always sent) |
| Open at night | `alert_open_at_night`, `alert_night_start`, `alert_night_end` | `alert_open_at_night: false` | change the night window |
| Low battery | `alert_battery_below` | `0` | raise/lower the % threshold |
| Temperature | `alert_temp_enabled`, `alert_temp_low`, `alert_temp_high`, `alert_temp_entities` | `alert_temp_enabled: false` | set your low/high band; scope to specific sensors with `alert_temp_entities` |
| High CO2 | `alert_co2_above` | `0` | set the ppm threshold (default 1400) |
| Humidity | `alert_humidity_enabled`, `alert_humidity_low`, `alert_humidity_high` | `alert_humidity_enabled: false` | set your low/high %RH band |
| Offline / network | `alert_offline`, `alert_offline_entities` | `alert_offline: false` | edit the watched-entity list |

**Adding a device to the offline watch.** To be alerted when a critical device
drops off — your NAS, a camera, a second router — add its `entity_id` to
`alert_offline_entities`:

```yaml
alert_offline_entities:
  - device_tracker.my_gateway  # your internet gateway
  - sensor.nas_status
  - camera.front_door
```

Any listed entity that reports `unavailable` or `unknown` — or, for a
`device_tracker`, `not_home` — raises a critical *Offline: …* alert. For a
`device_tracker`, watch **always-present infrastructure** (a gateway, NAS, or
camera) — avoid a person's phone tracker, or you'll get an *Offline* alert every
time they leave home. **To remove** a watched device, delete its line (keep the gateway if you still want
internet-down detection, or set `alert_offline: false` to switch the whole check
off). An empty list — which is how the add-on starts — leaves `alert_offline: true`
watching **nothing**, so the check costs you nothing until you fill it in.
Changes take effect after you save the options
and restart the add-on — the alerts loop reads its options when it starts.

**Scoping the temperature check.** The temperature alert checks every
`temperature` sensor by default, which includes **device** temperatures — a NAS,
a switch, or a CPU sensor happily running at 45–75° — that would trip a false
*Temperature out of range* alert. List just your **room** temperature sensors in
`alert_temp_entities` to check only those:

```yaml
alert_temp_entities:
  - sensor.living_room_temperature
  - sensor.bedroom_temperature
```

When the list is non-empty, only the entities on it are checked; every other
temperature sensor (including device temps) is ignored. Leave it empty (or unset)
to keep the legacy behaviour of checking **all** temperature sensors.

## The companion integration (Prompt API)

A separate Home Assistant integration, **AI Agent** (`claude_ha`), lets you talk
to Codex from **Assist** (text and voice) and from an `ask` service in
automations — without opening the console. It talks to this add-on over a
dedicated, locked-down HTTP endpoint called the **Prompt API**.

The Prompt API is designed for running Codex on **untrusted input** (whatever a
chat message or automation sends) with limited Home Assistant access, so it is
deliberately much more restricted than the interactive console:

- **Separate internal port, never published to the host.** It is reachable
  only from Home Assistant's internal network; requests from anywhere else are
  refused.
- **Bearer token on every request** (constant-time checked). The add-on generates
  the token and shares it with the integration automatically through Supervisor
  discovery — you configure nothing.
- **Each prompt runs a fresh, stateless, read-only Codex** with deny-by-default
  permissions: shell and web tools are removed entirely, file writes are refused
  by the read-only sandbox, and the child process gets **none** of your
  Supervisor or Home Assistant credentials in its environment. Home Assistant
  access, when enabled, is only through the
  **Model Context Protocol Server** integration, so Codex can see and touch
  **only the entities you have exposed to Assist**.
- **What bounds such a run, exactly.** A read-only sandbox first: the CLI itself
  refuses a file write in that mode, measured inside this add-on — with the
  sandbox read-only a forced patch was rejected ("writing is blocked by
  read-only sandbox") and nothing was written, and that is the mode every prompt
  run asks for. Around it: an empty, private working directory created for the
  run and removed with it; the user's own configuration, project instructions
  and rules are not read (`--ignore-user-config`, `--ignore-rules`,
  `--strict-config`, `project_doc_max_bytes=0`); nothing may be approved mid-run
  (`approval_policy="never"`); the web is off (`web_search="disabled"`); and
  every tool that runs a command, reaches the network or loads something you
  installed is switched off by name. On the Home Assistant side the run is given
  a tool server carrying only the tools that request allows, and everything it
  sends passes the add-on's own loopback relay, which forwards nothing but that
  tool server and a camera snapshot, never hands out your Home Assistant token,
  and writes each call to the audit log. What the sandbox cannot add here is
  process-level isolation: the CLI's Linux sandbox needs a privilege an add-on
  container does not have, so the enclosing boundary is the container itself.
- **Actions require confirmation, and the confirmed action is executed from the
  validated request only.** A read request that would change state returns a
  *proposal* rather than acting; the integration asks you to confirm; only then
  is a second, tightly-scoped call allowed to perform exactly that action — and
  that call is driven solely by the validated intent, never by the original
  free-form message, so untrusted text never reaches the state-changing path.
- Rate-limited, concurrency-capped, time-bounded, output-capped, and
  secret-redacted; no transcript of a request is kept once it has answered. A
  Home Assistant call a request makes is written to the audit log (`ha-audit`)
  with the arguments it used and what Home Assistant answered — written when Home
  Assistant answers it, where the call passes rather than by the agent itself, so
  the record does not depend on the agent keeping it. A call that failed is recorded too, marked `(failed)`, and a call still
  unanswered when the add-on stops is settled rather than dropped. Read the limit
  with it: in this version a write to that log that fails — a full or read-only
  `/data` — is not detected, so an action can happen with no line and nothing
  saying so.
- **Its own model — optionally faster for voice.** The companion chat can run a
  different model from the interactive console (`chat_model`) — e.g. a quicker,
  cheaper one for snappy Assist replies — and spoken (voice) turns can use an even
  faster model (`chat_model_voice`), since voice answers are short and lower
  latency matters more there than raw capability. Carrying out a confirmed action
  (`chat_model_write`) and answering from a camera snapshot (`chat_model_camera`)
  can each have their own model too. All of these are optional; leave them empty
  to use the console's model. Replies are also written in your Home
  Assistant language, and voice replies are kept to one short, spoken-friendly
  sentence.

### What the add-on reports about itself (`/api/status`)

Besides readiness and the add-on's own `version`, `/api/status` names the agent
behind the Prompt API, so the integration can adapt to it:

| field | meaning |
|---|---|
| `ready` | `true` only when the CLI is installed **and** the add-on has a sign-in: either `codex login` has been completed in the console (it stores the sign-in under `/data/codex`) or **API Key** is set in the options. A freshly installed add-on reports `false` until one of those happens — the normal state between installing and signing in, not a fault, and no request has to be made first |
| `engine` | the agent's stable name; `codex` for this add-on |
| `engine_version` | the agent's version, as `codex --version` reports it; empty until it has been read |
| `request_fields` | the request fields `POST /api/prompt` accepts; a field not listed is refused |
| `prompt_max_bytes`, `body_max_bytes` | the largest prompt and request body `POST /api/prompt` accepts |

There is no `budget` field: this add-on's CLI reports no cost, so no spend is
counted and no daily budget can be enforced.

Every error answer carries a stable `code` next to its message (and `field` or
`limit_bytes` where they apply); the codes are listed in
[ha-agent-core](https://github.com/LayerTM/ha-agent-core#error-answers).

### Chat reliability (`chat_health`)

`/api/status` publishes a rolling window over the last 50 companion-chat runs,
which the integration turns into a *chat health* sensor. The window is durable —
it survives an add-on restart, so an update does not reset it to a flattering
blank — and it is trimmed by **count**, never by age.

That last point is deliberate, and it is why the fields below exist. On an install
where Assist is used a few times a day, "the last 50 runs" spans weeks. So the
add-on reports **what happened, in what order, and when**, and leaves the question
of *what counts as healthy* to the consumer, which is where the threshold can be
changed without an add-on release.

| field | meaning |
|---|---|
| `recent` | runs in the window (its full size) |
| `degraded` | how many of them failed |
| `recovered` | how many succeeded only after a retry (a subset of the successes, never of `degraded`) |
| `consecutive_ok` | successes since the last failure — proves a recovery by evidence instead of by a timer |
| `consecutive_failed` | failures since the last success — makes a fresh outage visible before it has diluted the window enough to move the rate |
| `last_reason` | why the most recent failure failed: a short token such as `model-error` or `timeout`, never prompt text or model output |
| `last_failure_ts` | when that same failure happened |
| `window_from_ts` / `window_to_ts` | the span the window actually covers |
| `window_dated` | how many of `recent` those two bounds were measured from |

Every `*_ts` is **epoch milliseconds**, and **`null` means unknown** — never "now"
and never `0`. A field that is **absent** rather than null means the add-on predates it.

**Read the span together with `window_dated`.** It says how many runs the bounds
came from, and it is what makes them readable: `window_dated` equal to `recent`
means the span covers the whole window, a smaller number means it covers only the
part that carries times, and `1` means the two bounds are one sample — a point,
not a span. Undated runs are the reason the two numbers can differ.

`recent = degraded + successes`, so `recent - degraded` is the number of
successful runs, and a failure rate is `degraded / recent`.

### Account limits (`/api/account_limits`)

`/api/usage` reports what **this add-on** spent, in tokens. `/api/account_limits`
reports something different: how much of **your account's** limits you have
used — across every machine and every session, not just the ones that ran here.
It is published so the integration can turn it into sensors: a percentage per
limit (the session window, the week, and the week for a particular model where
your plan has one), with when that limit resets and how severe the current level
is. There are no token counts and no money in it — a ChatGPT plan's limits are
expressed as percentages, so that is what you get.

If you authenticate with an **API key** rather than a ChatGPT plan, the endpoint
answers `{"mode": "api_key", "limits": []}`: an API key is billed per request and
has no such limit buckets, so there is nothing to show, and the integration
creates no limit sensors instead of showing empty ones. When the account's
credentials are missing or the upstream service cannot be reached, the endpoint
returns `503` and the sensors go unavailable — it never reports a made-up `0 %`.

### Manage automations by chatting

With the companion integration you can **create, edit, and delete automations** by
describing them in plain language to Assist (text or voice) — no YAML, no editor:

- *"Create an automation that turns on the porch light at sunset."*
- *"Change my porch-light automation to come on at 21:00."*
- *"Delete my porch-light automation."*

Codex drafts the automation (or the edit) and shows it to you; **nothing is
written until you confirm** (yes/no). Safety is built in: before saving, the
integration re-validates the configuration against Home Assistant's own automation
schema and permits only a safe set of service calls — it refuses code execution
(`shell_command`, `python_script`) and payloads that could reach arbitrary
devices, so a drafted automation can only do ordinary household things. An edit
preserves the parts you didn't ask to change; a delete always asks first and, when
more than one automation matches, asks which — it never removes an ambiguous one.

To use it, install the `claude_ha` integration (it will detect this add-on
automatically) and, for live HA context, install Home Assistant's *Model Context
Protocol Server* integration and set `prompt_ha_token`. To turn the endpoint off
entirely, set `prompt_api` to false.

## Persistence

Everything that matters lives in `/data` and survives restarts and updates: login and sessions (`/data/codex`), uploads (`/data/uploads`). Resume the last conversation with `codex --resume` or the corresponding option in the exit menu.

## Troubleshooting

- **Blank screen** — check the add-on log; restart the add-on.
- **401 / frozen after long idle** — the ingress session expires after 15 minutes without traffic; the console reloads automatically, or refresh the page.
- **Copy does not reach the clipboard** — rare now (selecting text copies in the pointer gesture, which works over plain HTTP too). If a browser blocks the clipboard even inside a gesture, the text is still saved to the 📥 tray — one tap to copy — and serving HA over HTTPS avoids it entirely.
- **TLS on Home Assistant itself** — if you set `ssl_certificate` in the `http:` integration, or moved
  Core off port 8123, the add-on follows automatically: it asks the Supervisor where Core listens
  instead of assuming `http://homeassistant:8123`. Nothing to configure. Inside the add-on,
  `$HA_URL` always holds the right address — prefer it over a hardcoded one in scripts.
- **`bypass_permissions` refuses to start** — if a CLI update ever breaks this, run `update-codex <previous-version>` in a shell tab and report an issue.

## Support

Issues: [github.com/LayerTM/CodexInHA](https://github.com/LayerTM/CodexInHA/issues)
