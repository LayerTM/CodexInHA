#!/usr/bin/env python3
"""Self-test for lint_targets.py, on repositories built for the occasion."""

from __future__ import annotations

import os
import subprocess
import sys
import tempfile

import lint_targets


def git(repo: str, *args: str) -> None:
    subprocess.run(["git", *args], cwd=repo, check=True, capture_output=True)


def make_repo(files: dict[str, tuple[str, bool]]) -> str:
    repo = tempfile.mkdtemp()
    git(repo, "init", "-q")
    for name, (content, executable) in files.items():
        path = os.path.join(repo, name)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w", encoding="utf-8") as fh:
            fh.write(content)
        os.chmod(path, 0o755 if executable else 0o644)
    git(repo, "add", "-A")
    return repo


def check(condition: bool, message: str) -> None:
    if not condition:
        print(f"FAIL: {message}", file=sys.stderr)
        sys.exit(1)


def test_groups_by_interpreter() -> None:
    repo = make_repo({
        "bin/a": ("#!/usr/bin/env bash\ntrue\n", True),
        "bin/b": ("#!/bin/sh\ntrue\n", True),
        "bin/c": ("#!/usr/bin/env node\n'use strict';\n", True),
        "bin/d": ("#!/usr/bin/python3\npass\n", True),
        "bin/e": ("#!/usr/bin/bashio\ntrue\n", True),
        # Not executable: it is not a script the repository ships as a command.
        "lib/f": ("#!/usr/bin/env node\n", False),
    })
    groups, unknown = lint_targets.classify(repo)
    check(groups["shell"] == ["bin/a", "bin/b", "bin/e"], f"shell group: {groups['shell']}")
    check(groups["node"] == ["bin/c"], f"node group: {groups['node']}")
    check(groups["python"] == ["bin/d"], f"python group: {groups['python']}")
    check(unknown == [], f"unknown: {unknown}")


def test_an_executable_nobody_checks_fails() -> None:
    for content in ("#!/usr/bin/env perl\nprint 1;\n", "no shebang at all\n"):
        repo = make_repo({"bin/x": (content, True)})
        groups, unknown = lint_targets.classify(repo)
        check(unknown == ["bin/x"], f"{content!r} must be unknown, got {unknown} {groups}")
        check(lint_targets.main(["--repo", repo]) == 1, "the report must fail")
        # A list is refused too: a caller must never lint a subset silently.
        check(lint_targets.main(["--repo", repo, "--list", "shell"]) == 1, "the list must fail")


def test_root_makes_paths_relative() -> None:
    repo = make_repo({"codex/bin/a": ("#!/usr/bin/env node\n", True), "other/b": ("#!/bin/sh\n", True)})
    groups, _ = lint_targets.classify(repo)
    check(groups["node"] == ["codex/bin/a"], f"node group: {groups['node']}")
    check(lint_targets.main(["--repo", repo, "--list", "node", "--root", "codex"]) == 0, "listing failed")


def main() -> int:
    test_groups_by_interpreter()
    test_an_executable_nobody_checks_fails()
    test_root_makes_paths_relative()
    print("lint_targets: ok")
    return 0


if __name__ == "__main__":
    sys.exit(main())
