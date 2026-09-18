# Changelog

## 0.1.2

- Ask the add-on a question and it answers. In 0.1.1 only the first question of
  a session reached the assistant: the Codex CLI records which directory it has
  been asked to trust in a configuration file of its own, the add-on keeps
  question runs in a home of their own so they read none of your instructions,
  and the check that enforced that refused to start a run once the CLI had
  written that file. Every question after the first failed. The check now knows
  the difference between an instructions file, which still stops a run, and the
  CLI's own configuration, which is cleared before each run.

## 0.1.1

- The Codex CLI is on `PATH` in a shell tab. In 0.1.0 a tab answered
  `codex: command not found`: a tab is a login shell, which rebuilds `PATH` from
  scratch and threw away the directory the add-on installs the CLI into. The
  add-on now declares that directory once and gives it to every shell it opens,
  so `codex`, `codex login` and `update-codex` all work in a tab.
- The documentation says what turns `/api/status`'s `ready` true: a completed
  `codex login`, or an **API Key** in the options.

## 0.1.0

First version of the add-on.

**The console**

- The Codex CLI itself, in a browser tab: your own sign-in, your own model, and the
  skills, plugins and MCP servers you install, kept in `/data` across add-on updates.
- Sign in from the console with ChatGPT (`codex login`), or set an API key in the
  add-on options.
- Tabs — the Codex session alongside any number of shell tabs — a clipboard that works
  over plain HTTP, drag-and-drop and camera attachments, a searchable scrollback, a
  quick-prompt menu that inserts text instead of running it, and a touch key bar on
  phones. The session lives in tmux, so closing the browser does not end it.
- Home Assistant is already wired up: `ha`, `ha-state`, `ha-check`, `ha-shot`,
  `ha-audit`, `hass-cli`, `yq`, a Playwright browser and a bundled Home Assistant skill
  pack, with your configuration directory as the working directory.
- The CLI updates from the console (⬆ or `update-codex`), optionally at every start.
- Optional remote control: drive the same session from the ChatGPT mobile app.

**Chat from Assist**

- A prompt API for the companion integration, on an internal port, with a bearer token
  the add-on generates and hands over through Supervisor discovery.
- A request runs a fresh Codex with no shell, no web search and none of your own
  configuration, in a read-only sandbox that refuses a file write, in an empty private
  directory removed with the run. It may call only the Home Assistant tools that request
  allows, and only for entities you have exposed to Assist.
- An action is proposed first and carried out only after you confirm it, from the
  validated request rather than from the original message.
- Every Home Assistant call a request makes is written to the audit log (`ha-audit`)
  with its arguments, where the call passes rather than by the agent itself; a call that
  failed is marked `(failed)`, and one still unanswered when the add-on stops is settled
  instead of vanishing. **Known limit:** a failure of the write to that log — a full or
  read-only `/data` — is not detected, so an action can happen with no line and nothing
  saying so.
- The chat can use its own models, including a faster one for voice answers and one for
  camera snapshots.

**Alerts and reports, without a model**

- Opt-in deterministic alerts: water leak, an opening left open at night, low battery,
  temperature or humidity out of band, high CO2, and a watched device going offline.
  Fixed rules, no Codex call, no plan usage, no prompt-injection surface. Quiet hours
  hold back the non-critical ones; a leak and a watched device going offline are always
  sent.
- Optional proactive monitoring and a morning digest, which do use the CLI.

**Accounting**

- Usage is reported per day and per model. This CLI reports no cost anywhere, so the
  add-on publishes none and enforces no daily budget.
- Uploaded files and session transcripts are deleted after their retention period (14
  and 30 days by default; 0 keeps them). What they counted stays counted after they are
  gone.

**Where the rest comes from**

- The console, the prompt server and the background loops come from the `ha-agent-core`
  release pinned in `core/core.lock.json`. Its digest is verified before the archive is
  unpacked into the image.
