#!/usr/bin/env python3
"""Self-test for pins_drift.py — offline: git runs against a local bare
repository and `gh` is a recording stand-in on PATH.

The two answers that matter: a pin behind its upstream fails a pull request and
leaves main green with the bump pull request opened; an upstream that could not
be read fails both.

Run: python3 .github/scripts/test_pins_drift.py
"""

from __future__ import annotations

import contextlib
import io
import json
import os
import pathlib
import subprocess
import sys
import tempfile

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import pins_drift  # noqa: E402

FAILURES: list[str] = []

# Stands in for pins.py bump: moves the one pin in pins.txt to the value in
# $FAKE_BUMP_TO and writes the summary pins.py would write; an empty value means
# "already current", and $FAKE_BUMP_EXIT makes it fail like an unreadable upstream.
FAKE_BUMP = """
import json, os, pathlib, sys
if os.environ.get("FAKE_BUMP_EXIT"):
    sys.exit(int(os.environ["FAKE_BUMP_EXIT"]))
to = os.environ.get("FAKE_BUMP_TO", "")
pin = pathlib.Path("pins.txt")
was = pin.read_text().strip()
changes = []
if to and to != was:
    pin.write_text(to + "\\n")
    changes = [{"name": "TOOL_VERSION", "file": "pins.txt", "kind": "npm", "source": "tool",
                "from": was, "to": to, "major": False},
               {"name": "TOOL_SHA256", "file": "pins.txt", "kind": "claude-code-sha256",
                "source": "linux-x64", "from": "a", "to": "b", "major": False}]
pathlib.Path(sys.argv[sys.argv.index("--summary") + 1]).write_text(json.dumps(changes))
"""

# Records every call; `pr list` answers from $FAKE_GH_OPEN, `pr create` prints a URL.
FAKE_GH = """#!/usr/bin/env python3
import json, os, sys
with open(os.environ["FAKE_GH_LOG"], "a") as log:
    log.write(json.dumps(sys.argv[1:]) + "\\n")
args = sys.argv[1:]
if args[:2] == ["pr", "list"]:
    print(os.environ.get("FAKE_GH_OPEN", ""))
elif args[:2] == ["pr", "create"]:
    if os.environ.get("FAKE_GH_CREATE_FAILS"):
        sys.exit(1)
    print("https://github.com/owner/repo/pull/77")
"""


def check(name: str, ok: bool, detail: str = "") -> None:
    print(("ok   " if ok else "FAIL ") + name + (f": {detail}" if detail and not ok else ""))
    if not ok:
        FAILURES.append(name)


def sh(cwd: pathlib.Path, *cmd: str) -> str:
    return subprocess.run(list(cmd), cwd=cwd, capture_output=True, text=True, check=True).stdout.strip()


@contextlib.contextmanager
def env(**values: str):
    saved = {k: os.environ.get(k) for k in values}
    os.environ.update(values)
    try:
        yield
    finally:
        for key, value in saved.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value


def outputs(path: pathlib.Path) -> dict[str, str]:
    return dict(line.split("=", 1) for line in path.read_text().split()) if path.exists() else {}


def test_verdict() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        for ref, status, want_exit, want_drift in [
            ("refs/heads/main", 0, 0, "false"),
            ("refs/heads/main", 1, 0, "true"),     # drift on main: green, recorded
            ("refs/heads/main", 2, 2, "false"),    # unreadable upstream: red on main too
            ("refs/pull/5/merge", 0, 0, "false"),
            ("refs/pull/5/merge", 1, 1, "false"),  # drift on a pull request: red
            ("refs/pull/5/merge", 2, 2, "false"),
            ("refs/heads/pins/bump", 1, 1, "false"),  # the bump branch itself is gated
        ]:
            out = pathlib.Path(tmp) / f"out-{abs(hash((ref, status)))}"
            step = pathlib.Path(tmp) / "summary.md"
            with env(GITHUB_OUTPUT=str(out), GITHUB_STEP_SUMMARY=str(step)), \
                    contextlib.redirect_stdout(io.StringIO()):
                got = pins_drift.verdict(status, ref)
            check(f"verdict {ref} status {status} exits {want_exit}", got == want_exit, f"got {got}")
            check(f"verdict {ref} status {status} drift={want_drift}",
                  outputs(out).get("drift") == want_drift, str(outputs(out)))


class Repo:
    """A clone of a bare origin whose main holds pins.txt at 1.0.0."""

    def __init__(self, tmp: pathlib.Path):
        self.origin = tmp / "origin.git"
        self.root = tmp / "clone"
        self.log = tmp / "gh.log"
        self.bump = tmp / "fake_bump.py"
        self.bump.write_text(FAKE_BUMP)
        bindir = tmp / "bin"
        bindir.mkdir()
        (bindir / "gh").write_text(FAKE_GH)
        (bindir / "gh").chmod(0o755)
        self.path = f"{bindir}{os.pathsep}{os.environ['PATH']}"
        sh(tmp, "git", "init", "--quiet", "--bare", "--initial-branch=main", str(self.origin))
        sh(tmp, "git", "clone", "--quiet", str(self.origin), str(self.root))
        # The machine's own git hooks are not part of what is tested here.
        sh(self.root, "git", "config", "core.hooksPath", ".git/hooks")
        (self.root / "pins.txt").write_text("1.0.0\n")
        self.commit("start", "Maintainer", "maintainer@example.com")
        sh(self.root, "git", "push", "--quiet", "origin", "HEAD:refs/heads/main")
        self.temp = tmp / "runner-temp"
        self.temp.mkdir()

    def commit(self, message: str, name: str, email: str) -> None:
        sh(self.root, "git", "add", "--all")
        sh(self.root, "git", "-c", f"user.name={name}", "-c", f"user.email={email}",
           "commit", "--quiet", "-m", message)

    def to_main(self) -> None:
        sh(self.root, "git", "fetch", "--quiet", "origin")
        sh(self.root, "git", "switch", "--quiet", "--detach", "origin/main")

    def run(self, **extra: str) -> tuple[int, list[list[str]], str]:
        self.to_main()
        self.log.write_text("")
        step = self.temp / "summary.md"
        step.write_text("")
        values = {"PATH": self.path, "FAKE_GH_LOG": str(self.log), "RUNNER_TEMP": str(self.temp),
                  "GITHUB_STEP_SUMMARY": str(step), "FAKE_BUMP_TO": "", "FAKE_GH_OPEN": "",
                  "FAKE_BUMP_EXIT": "", "FAKE_GH_CREATE_FAILS": ""}
        values.update(extra)
        with env(**values), contextlib.redirect_stdout(io.StringIO()), \
                contextlib.redirect_stderr(io.StringIO()):
            try:
                code = pins_drift.open_pr(self.root, [sys.executable, str(self.bump)])
            except pins_drift.Failed:
                code = -1
        calls = [json.loads(line) for line in self.log.read_text().splitlines()]
        return code, calls, step.read_text()

    def branch(self) -> str:
        return sh(self.root, "git", "ls-remote", "origin", "refs/heads/pins/bump").split("\t")[0]


def names(calls: list[list[str]]) -> list[str]:
    return [" ".join(c[:2]) for c in calls]


def test_open_pr() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        repo = Repo(pathlib.Path(tmp))

        code, calls, text = repo.run()
        check("no drift left: nothing pushed, no pull request", code == 0 and calls == [] and not repo.branch(),
              f"{code} {calls}")

        code, calls, text = repo.run(FAKE_BUMP_EXIT="2")
        check("bump that cannot read an upstream fails", code == 2 and calls == [], f"{code} {calls}")

        code, calls, text = repo.run(FAKE_BUMP_TO="1.1.0")
        first = repo.branch()
        check("drift on main: the branch is pushed", bool(first))
        check("drift on main: pull request created, then CI dispatched on the branch",
              names(calls) == ["pr list", "pr create", "workflow run"], str(names(calls)))
        check("CI dispatch names ci.yml on pins/bump",
              calls[-1] == ["workflow", "run", "ci.yml", "--ref", "pins/bump"], str(calls[-1:]))
        check("open-pr exits 0 (main stays green)", code == 0)
        check("summary names the pull request", "#77" in text, text)
        made = sh(repo.root, "git", "log", "-1", "--format=%ae %ce %s%n%b", first)
        check("the commit is the workflow's own identity",
              made.startswith(f"{pins_drift.BOT_EMAIL} {pins_drift.BOT_EMAIL} {pins_drift.TITLE}"), made)
        check("the commit lists the version, not its checksum",
              "TOOL_VERSION: 1.0.0 → 1.1.0" in made and "TOOL_SHA256" not in made, made)
        check("the commit sits on main", sh(repo.root, "git", "rev-parse", f"{first}^")
              == sh(repo.root, "git", "rev-parse", "origin/main"))
        body = next(c for c in calls if c[:2] == ["pr", "create"])
        check("pull request body lists the move", "TOOL_VERSION: 1.0.0 → 1.1.0" in body[body.index("--body") + 1])

        code, calls, text = repo.run(FAKE_BUMP_TO="1.1.0", FAKE_GH_OPEN="77")
        check("same bump again: branch untouched, one pull request edited, no new CI run",
              repo.branch() == first and names(calls) == ["pr list", "pr edit"], f"{names(calls)}")

        code, calls, text = repo.run(FAKE_BUMP_TO="1.2.0", FAKE_GH_OPEN="77")
        second = repo.branch()
        check("a newer upstream: the one branch moves (not a second pull request)",
              second != first and names(calls) == ["pr list", "pr edit", "workflow run"], f"{names(calls)}")

        # main moves on: the bump is rebuilt on the new main.
        repo.to_main()
        (repo.root / "other.txt").write_text("x\n")
        repo.commit("other", "Maintainer", "maintainer@example.com")
        sh(repo.root, "git", "push", "--quiet", "origin", "HEAD:refs/heads/main")
        code, calls, text = repo.run(FAKE_BUMP_TO="1.2.0", FAKE_GH_OPEN="77")
        third = repo.branch()
        check("main moved: the branch is rebuilt on it",
              sh(repo.root, "git", "rev-parse", f"{third}^") == sh(repo.root, "git", "rev-parse", "origin/main"))

        # A person adds a commit: the workflow leaves the branch alone.
        sh(repo.root, "git", "fetch", "--quiet", "origin", "refs/heads/pins/bump:refs/remotes/origin/pins/bump")
        sh(repo.root, "git", "switch", "--quiet", "--detach", "origin/pins/bump")
        (repo.root / "CHANGELOG.md").write_text("- tool 1.2.0\n")
        repo.commit("changelog", "Maintainer", "maintainer@example.com")
        sh(repo.root, "git", "push", "--quiet", "origin", "HEAD:refs/heads/pins/bump")
        held = repo.branch()
        code, calls, text = repo.run(FAKE_BUMP_TO="1.3.0", FAKE_GH_OPEN="77")
        check("a maintainer's commit on the branch: left as it is, green",
              code == 0 and repo.branch() == held and calls == [], f"{code} {calls}")

    with tempfile.TemporaryDirectory() as tmp:
        repo = Repo(pathlib.Path(tmp))
        code, calls, text = repo.run(FAKE_BUMP_TO="1.1.0", FAKE_GH_CREATE_FAILS="1")
        check("a pull request that cannot be created fails the step", code == -1, f"{code}")


def main() -> None:
    test_verdict()
    test_open_pr()
    if FAILURES:
        print(f"{len(FAILURES)} failure(s)")
        sys.exit(1)
    print("all pins_drift tests passed")


if __name__ == "__main__":
    main()
