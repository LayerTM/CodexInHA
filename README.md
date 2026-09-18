# Codex for Home Assistant

A Home Assistant add-on that runs the [Codex CLI](https://github.com/openai/codex)
with a web console and a prompt API for the Home Assistant conversation agent.

**Status: in development.** There is no installable release yet; this repository
will be usable as a Home Assistant add-on repository once the first version is
published.

## What is in here

| path | what it is |
|---|---|
| `codex/` | the add-on: its Dockerfile, options, engine hooks and the Codex adapter |
| `codex/app/adapter/` | everything the console and the prompt API need to know about Codex |
| `codex/core/` | the pinned `ha-agent-core` release and the reviewed verifier that checks it |
| `codex/rootfs/` | the service, the engine hooks and the commands the add-on installs |
| `codex/skills/` | the bundled Home Assistant skill pack |

The console, the prompt server and the background loops are not in this
repository: they come from the [`ha-agent-core`](https://github.com/LayerTM/ha-agent-core)
release pinned in `codex/core/core.lock.json`, verified against that lock before
anything is merged into the image.

## Building and testing

The tests run against the tree the image ships — this repository's files merged
with the pinned core:

```sh
.github/scripts/core_archive.sh /tmp/core
codex/core/assemble.sh /tmp/core/core.tar codex /tmp/addon
cd /tmp/addon/app && "/tmp/addon/install-tools/npm-ci-checked.sh" && npm test
```

The add-on's own tests need none of that and run straight from a checkout, with
no dependencies to install:

```sh
cd codex/app && node --test test/
```

`npm run lint` and `npm run typecheck` do need the assembled tree: eslint and
typescript arrive with the core, not with this repository.

## Licence

[MIT](LICENSE)
