#!/usr/bin/env python3
"""What a pin behind its upstream means, and where it goes: a bump pull request.

A pull request is the change that has to be right, so on a pull request (and on
any branch other than main) a pin behind its upstream fails the "Upstream pins"
check, exactly as `pins.py check` reports it. On main the same answer is news,
not a defect of the commit: the upstream published a release after the commit
passed. Turning main red for it only says "something upstream moved" in the
colour that means "this commit is broken". So on main the drift is recorded,
the run stays green, the release is held back (ci.yml's release job reads the
`drift` output), and one pull request carries the bump.

An upstream that could not be read is never drift: `pins.py check` exits 2 for
it and that stays a failure everywhere, because a reading that did not happen
is not a reading that said "behind".

Commands:
  verdict STATUS
      STATUS is the exit status of `pins.py check`. Writes `drift=true|false`
      to $GITHUB_OUTPUT and exits with the status the check must have here:
      0 current, 1 behind (red on any ref but main; green with drift=true on
      main), anything else unchanged.

  open-pr
      On main, with drift recorded: runs `pins.py bump`, commits the result on
      top of main to the branch `pins/bump`, opens the pull request for it (or
      updates the one already open), and starts ci.yml on that branch. A pull
      request made with the workflow token raises no pull_request event, and a
      workflow_dispatch is the one event that token may start; the run it
      starts reports every check the pull request is required to pass, on the
      very commit the pull request points at.

      The branch belongs to this workflow. A commit on it that the workflow did
      not make (a maintainer adding the changelog line, say) means a person is
      finishing it, and the branch is then left exactly as it is.

Both commands write what they decided to $GITHUB_STEP_SUMMARY when it is set.
"""

from __future__ import annotations

import json
import os
import pathlib
import subprocess
import sys

MAIN_REF = "refs/heads/main"
BRANCH = "pins/bump"
BOT_NAME = "github-actions[bot]"
BOT_EMAIL = "41898282+github-actions[bot]@users.noreply.github.com"
TITLE = "Move upstream pins to their latest releases"
SCRIPTS = pathlib.Path(__file__).resolve().parent


def out(name: str, value: str) -> None:
    path = os.environ.get("GITHUB_OUTPUT")
    if path:
        with open(path, "a", encoding="utf-8") as handle:
            handle.write(f"{name}={value}\n")


def summary(text: str) -> None:
    print(text)
    path = os.environ.get("GITHUB_STEP_SUMMARY")
    if path:
        with open(path, "a", encoding="utf-8") as handle:
            handle.write(text + "\n")


def verdict(status: int, ref: str) -> int:
    if status == 0:
        out("drift", "false")
        return 0
    if status == 1 and ref == MAIN_REF:
        out("drift", "true")
        summary(
            "**Upstream pins:** at least one pin is behind its upstream (listed in this job's log). "
            "This commit is not failed for it: the release waits, and the bump arrives as the "
            f"pull request from `{BRANCH}`."
        )
        return 0
    out("drift", "false")
    if status == 1:
        summary("**Upstream pins:** a pin is behind its upstream. Run `python3 .github/scripts/pins.py bump`.")
    else:
        summary(f"**Upstream pins:** an upstream could not be read (exit {status}); that is not a reading.")
    return status


class Failed(Exception):
    pass


def run(*cmd: str, cwd: pathlib.Path, check: bool = True) -> subprocess.CompletedProcess:
    done = subprocess.run(list(cmd), cwd=cwd, capture_output=True, text=True, check=False)
    if check and done.returncode != 0:
        raise Failed(f"{' '.join(cmd)} exited {done.returncode}: {(done.stderr or done.stdout).strip()}")
    return done


def git(root: pathlib.Path, *args: str, check: bool = True) -> str:
    return run("git", *args, cwd=root, check=check).stdout.strip()


def describe(changes: list[dict]) -> list[str]:
    lines = []
    for change in changes:
        if change["kind"].endswith("-sha256"):
            continue
        major = " (new major version)" if change.get("major") else ""
        lines.append(f"- {change['name']}: {change['from']} → {change['to']}{major} — `{change['file']}`, "
                     f"{change['kind']} {change['source']}")
    return lines


def body(changes: list[dict]) -> str:
    return "\n".join([
        "Every pin below has a newer upstream release than the one this repository builds on.",
        "",
        *describe(changes),
        "",
        "Checksums that belong to a version move with it. The change is exactly what "
        "`python3 .github/scripts/pins.py bump` writes on top of main.",
        "",
        "Before merging: add the changelog entry these updates need under the unreleased version.",
    ]) + "\n"


def open_pr(root: pathlib.Path, bump: list[str] | None = None) -> int:
    bump = bump or [sys.executable, str(SCRIPTS / "pins.py"), "bump"]
    main_sha = git(root, "rev-parse", "HEAD")
    record = pathlib.Path(os.environ.get("RUNNER_TEMP") or root) / "pins-bump.json"
    bumped = run(*bump, "--summary", str(record), cwd=root, check=False)
    print(bumped.stdout, end="")
    if bumped.returncode != 0:
        print(bumped.stderr, end="", file=sys.stderr)
        return bumped.returncode or 1
    changes = json.loads(record.read_text())
    record.unlink()
    if not changes or not git(root, "status", "--porcelain"):
        summary("**Upstream pins:** every pin matches its upstream now; no bump pull request is needed.")
        return 0

    remote = git(root, "ls-remote", "origin", f"refs/heads/{BRANCH}")
    old = remote.split()[0] if remote else ""
    if old:
        git(root, "fetch", "--quiet", "origin", f"refs/heads/{BRANCH}")
        # Every commit the branch has that main does not, author and committer.
        others = git(root, "log", "--format=%ae%n%ce", f"{main_sha}..{old}").split()
        if any(email != BOT_EMAIL for email in others):
            summary(f"**Upstream pins:** `{BRANCH}` carries a commit this workflow did not make; "
                    "it is left as it is for whoever is finishing it.")
            return 0

    git(root, "switch", "--quiet", "-C", BRANCH)
    git(root, "add", "--all")
    message = "\n".join([TITLE, "", *describe(changes)]) + "\n"
    git(root, "-c", f"user.name={BOT_NAME}", "-c", f"user.email={BOT_EMAIL}",
        "commit", "--quiet", "-m", message)
    new = git(root, "rev-parse", "HEAD")

    same = bool(old) and git(root, "rev-parse", f"{old}^") == main_sha and \
        git(root, "rev-parse", f"{old}^{{tree}}") == git(root, "rev-parse", f"{new}^{{tree}}")
    if same:
        head = old
        print(f"{BRANCH} already carries this bump on top of main")
    else:
        lease = f"--force-with-lease=refs/heads/{BRANCH}:{old}"
        git(root, "push", "--quiet", lease, "origin", f"HEAD:refs/heads/{BRANCH}")
        head = new
        print(f"pushed {BRANCH} at {new}")

    text = body(changes)
    listed = run("gh", "pr", "list", "--head", BRANCH, "--base", "main", "--state", "open",
                 "--json", "number", "--jq", ".[].number", cwd=root).stdout.split()
    if listed:
        number = listed[0]
        run("gh", "pr", "edit", number, "--title", TITLE, "--body", text, cwd=root)
    else:
        created = run("gh", "pr", "create", "--base", "main", "--head", BRANCH,
                      "--title", TITLE, "--body", text, cwd=root)
        number = created.stdout.strip().rsplit("/", 1)[-1]
    if not same:
        # A push made with the workflow token starts no workflow; this run is
        # what puts the required checks on the pull request's head commit.
        run("gh", "workflow", "run", "ci.yml", "--ref", BRANCH, cwd=root)
    summary(f"**Upstream pins:** the bump is pull request #{number} (`{BRANCH}` at {head[:12]})"
            + ("." if same else "; CI was started on it."))
    return 0


def main(argv: list[str]) -> int:
    root = SCRIPTS.parents[1]
    try:
        if len(argv) == 2 and argv[0] == "verdict" and argv[1].isdigit():
            return verdict(int(argv[1]), os.environ.get("GITHUB_REF", ""))
        if argv == ["open-pr"]:
            return open_pr(root)
    except Failed as err:
        print(f"error: {err}", file=sys.stderr)
        return 1
    print("usage: pins_drift.py verdict STATUS | open-pr", file=sys.stderr)
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
