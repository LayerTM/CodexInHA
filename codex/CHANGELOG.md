# Changelog

## 0.1.0

First version of the add-on.

- The Codex CLI in a Home Assistant add-on: a web console with tabs, a
  clipboard, file attachments and browser testing, and a bundled Home Assistant
  skill pack.
- Sign in from the console with ChatGPT (`codex login`), or set an API key in
  the add-on options.
- The prompt API for the conversation agent is built but does not start yet:
  every Home Assistant action a chat request takes has to be recorded with its
  arguments, and nothing writes that record while a request runs with every hook
  switched off. A request that cannot be recorded is not served. The console is
  not affected. When it does start, a request runs with no shell, no file
  access, no web search and none of the user's own configuration, and may call
  only the Home Assistant tools that request allows.
- The console's usage is reported per day and per model. This CLI reports no
  cost anywhere, so the add-on publishes none and has no daily budget.
- Session transcripts are kept for `transcript_retention_days` days (30 by
  default; 0 keeps them). What they counted stays counted after they are gone.
- The console, the prompt server and the background loops come from the
  `ha-agent-core` 0.5.0 release, verified against `core/core.lock.json`.
