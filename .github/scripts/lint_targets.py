#!/usr/bin/env python3
"""Which linter each executable script of this repository belongs to.

A script is checked for what it IS, not for where it happens to sit: the
interpreter on its first line decides which linter takes it. Nothing here is a
list of file names, so a file cannot fall out of one list without falling into
another — which is exactly what happened when an executable was rewritten from
shell into another language and quietly left every check behind.

    lint_targets.py                 # report; fails if a script has no linter
    lint_targets.py --list shell    # the files shellcheck takes
    lint_targets.py --list node     # the files eslint takes
    lint_targets.py --list python   # the files the Python checker takes
    lint_targets.py --list node --root codex   # the same, relative to codex/

Every tracked file the repository ships as executable is covered. A shebang
naming an interpreter this script does not know fails the run rather than being
skipped: an unknown interpreter is a script nobody checks.
"""

from __future__ import annotations

import argparse
import os
import subprocess
import sys

# The interpreter on the first line -> the linter that takes the file. Matched
# against the words of the shebang, so `#!/usr/bin/env bash` and `#!/bin/bash`
# are the same thing.
INTERPRETERS = {
    "sh": "shell",
    "bash": "shell",
    "bashio": "shell",
    "node": "node",
    "python": "python",
    "python3": "python",
}

GROUPS = ("shell", "node", "python")


def tracked_executables(repo: str) -> list[str]:
    out = subprocess.run(
        ["git", "ls-files", "--stage", "-z"],
        cwd=repo, capture_output=True, text=True, check=True,
    ).stdout
    files = []
    for entry in out.split("\0"):
        if not entry:
            continue
        meta, path = entry.split("\t", 1)
        mode = meta.split(" ", 1)[0]
        if mode == "100755":
            files.append(path)
    return sorted(files)


def shebang(repo: str, path: str) -> str | None:
    try:
        with open(os.path.join(repo, path), "rb") as fh:
            first = fh.readline(256)
    except OSError:
        return None
    if not first.startswith(b"#!"):
        return None
    return first[2:].decode("utf-8", "replace").strip()


def group_of(line: str | None) -> str | None:
    if not line:
        return None
    words = [w for w in line.replace("\t", " ").split(" ") if w]
    for word in words:
        name = os.path.basename(word)
        if name == "env":
            continue
        if name in INTERPRETERS:
            return INTERPRETERS[name]
        # The first real word is the interpreter; an unknown one is unknown.
        if not name.startswith("-"):
            return None
    return None


def classify(repo: str) -> tuple[dict[str, list[str]], list[str]]:
    groups: dict[str, list[str]] = {name: [] for name in GROUPS}
    unknown: list[str] = []
    for path in tracked_executables(repo):
        group = group_of(shebang(repo, path))
        if group is None:
            unknown.append(path)
        else:
            groups[group].append(path)
    return groups, unknown


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--list", choices=GROUPS, dest="group")
    parser.add_argument("--root", default="", help="print paths relative to this directory")
    parser.add_argument("--repo", default=".", help="the repository to read")
    args = parser.parse_args(argv)

    groups, unknown = classify(args.repo)

    if args.group:
        if unknown:
            print("lint_targets: " + ", ".join(unknown) + " have no known interpreter", file=sys.stderr)
            return 1
        for path in groups[args.group]:
            if args.root:
                prefix = args.root.rstrip("/") + "/"
                if not path.startswith(prefix):
                    continue
                path = path[len(prefix):]
            print(path)
        return 0

    for name in GROUPS:
        print(f"{name}: {len(groups[name])}")
        for path in groups[name]:
            print(f"  {path}")
    if unknown:
        print("\nno linter takes these executables:", file=sys.stderr)
        for path in unknown:
            print(f"  {path} (shebang: {shebang(args.repo, path) or 'none'})", file=sys.stderr)
        return 1
    print("\nevery executable script has a linter")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
