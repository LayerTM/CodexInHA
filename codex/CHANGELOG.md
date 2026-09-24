# Changelog

## 0.1.5

- Ask for an answer in a format of your own — "emoji only, nothing else" — and
  the answer still arrives. Codex is now held to the full shape of the answer on
  every request, so whatever format the question asks for, the reply stays
  something the integration can read; before, such a request could end in a
  model error instead (ha-agent-core 0.7.7 →
  [0.7.8](https://github.com/LayerTM/ha-agent-core/releases/tag/v0.7.8)).

## 0.1.4

- A streamed answer with an emoji in it arrives whole. The answer is sent in
  pieces, and a cut could fall between the two halves of a character outside the
  Basic Multilingual Plane — an emoji, and much of the world's script beyond it.
  Neither half is text, so a strict client rejected the piece and lost the answer.
  A cut now never splits a character, and the same holds where a length cap trims
  the stored conversation history or an error message
  (ha-agent-core 0.7.6 → [0.7.7](https://github.com/LayerTM/ha-agent-core/releases/tag/v0.7.7)).
- Codex CLI 0.155.0 → 0.156.1
  ([0.155.1](https://github.com/openai/codex/releases/tag/rust-v0.155.1),
  [0.156.0](https://github.com/openai/codex/releases/tag/rust-v0.156.0),
  [0.156.1](https://github.com/openai/codex/releases/tag/rust-v0.156.1)).
  With **Auto-Update** on, an installed add-on already moves its CLI at start;
  this is the version a fresh install begins with.
- Node.js 26.9.0 → 26.10.0
  ([release notes](https://github.com/nodejs/node/releases/tag/v26.10.0)).
- Playwright MCP 0.0.81 → 0.0.82
  ([release notes](https://github.com/microsoft/playwright-mcp/releases/tag/v0.0.82)).

## 0.1.3

- Ask the assistant about your home and it answers with your home. Home Assistant
  publishes each tool under the name of the API it comes from — `intent__HassTurnOn`,
  `homeassistant__GetLiveContext` — and the add-on predicted that spelling itself, in
  the filter it passed to the run and again when it matched an incoming call. The
  filter matched nothing, so the assistant was offered no Home Assistant tool at all
  and answered from nothing. Both places now take the name from the one function that
  states the rule, and a run records the full published name beside the short one.
- A question that asks for an action or an automation is answered instead of refused.
  The model behind this CLI accepts a structured answer only when every object in it
  is closed, while an intent's data and an automation block are open by nature; the
  add-on now says so before the run, and the shipped core reads that declaration.
- A run that goes wrong says why. A refused credential is written down instead of
  looking like an engine that simply called nothing, and the record of a run names
  what it actually did.
- The token of a question run is no longer passed on the command line, so it cannot
  appear in a process listing.
- Polish: every quoted phrase closes with a Polish quotation mark, not an ASCII one.

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
