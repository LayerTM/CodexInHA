# Changelog

## 0.1.0

First version of the add-on.

- The Codex CLI in a Home Assistant add-on: a web console with tabs, a
  clipboard, file attachments and browser testing, and a bundled Home Assistant
  skill pack.
- Sign in from the console with ChatGPT (`codex login`), or set an API key in
  the add-on options.
- A prompt API for the conversation agent: a request runs with no shell, no web
  search and none of the user's own configuration, in a read-only sandbox that
  refuses a file write, and may call only the Home Assistant tools that request
  allows. A Home Assistant call it makes is written to the audit log
  (`ha-audit`) with its arguments when Home
  Assistant answers it, recorded where the call passes rather than by the agent
  itself; a call that failed is marked `(failed)`, and one still unanswered when
  the add-on stops is settled instead of vanishing. A write to that log that
  fails is not detected in this version.
- The console's usage is reported per day and per model. This CLI reports no
  cost anywhere, so the add-on publishes none and has no daily budget.
- Session transcripts are kept for `transcript_retention_days` days (30 by
  default; 0 keeps them). What they counted stays counted after they are gone.
- The console, the prompt server and the background loops come from the
  `ha-agent-core` 0.6.0 release, verified against `core/core.lock.json`.
