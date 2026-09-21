#!/usr/bin/env python3
"""Self-test for release_notes.py — what a release's notes carry when a cut
was skipped for one or more version bumps in a row, and that the heading form
this repository's changelog is actually written in is the one it reads.

Its value is in four places: the instrument (a `gh` that cannot answer exits 1
exactly as "no such release" does, so a lookup read by exit code alone would
hand a release the whole changelog); the accumulation (a script that only ever took
the top changelog section would silently drop every bump superseded before its
own cut); where the boundary comes from (a boundary trusted from elsewhere
would drop just the same way whenever that source names a version this
changelog never had a section for); and the real file (a heading regex proved
only against a fixture can be wrong about the one changelog it will ever read).

Run: python3 .github/scripts/test_release_notes.py
"""

from __future__ import annotations

import datetime
import os
import pathlib
import subprocess
import sys
import tempfile

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import release_notes  # noqa: E402

REPO = pathlib.Path(__file__).resolve().parents[2]

CONFIG = 'name: "X"\nversion: "1.2.1"\n'

# The plain heading is what this repository writes; the bracketed one is what
# the same script reads in the repositories it came from. Both here, so that
# moving a changelog between the two forms never needs this script edited.
CHANGELOG = """# Changelog

## 1.2.1

- Second bump of the day.

## [1.2.0] — 2026-09-19

- First bump of the day.

## 1.1.9

- Already released.
"""

fails = 0


def text_of(path: pathlib.Path) -> str:
    """What the script wrote, or "" when it wrote nothing — a failing command
    must not stop the checks after it from being reported."""
    return path.read_text() if path.exists() else ""


def check(label: str, got, want) -> None:
    global fails
    if got == want:
        print(f"  ok  - {label}")
    else:
        print(f"  NOT ok - {label} (got {got!r}, want {want!r})")
        fails += 1


with tempfile.TemporaryDirectory() as raw:
    tmp = pathlib.Path(raw)
    config = tmp / "config.yaml"
    changelog = tmp / "CHANGELOG.md"
    config.write_text(CONFIG)
    changelog.write_text(CHANGELOG)

    print("version reads config.yaml")
    check("value", release_notes.parse_config_version(CONFIG), "1.2.1")

    print("version refuses a file with none")
    check("no version line", release_notes.parse_config_version("name: X\n"), None)

    print("both heading forms are one section each")
    check(
        "versions, newest first",
        [v for v, _ in release_notes.parse_changelog_sections(CHANGELOG)],
        ["1.2.1", "1.2.0", "1.1.9"],
    )

    print("notes walks the changelog itself and stops at the first real release")
    out = tmp / "notes.md"
    seen = []

    def released_only_119(version: str) -> bool:
        seen.append(version)
        return version == "1.1.9"

    code = release_notes.main(
        ["notes", str(config), str(changelog), "--write", str(out)],
        is_released=released_only_119,
    )
    check("exit code", code, 0)
    body = text_of(out)
    check("carries the second bump", "Second bump of the day" in body, True)
    check("carries the first bump (bracketed heading)", "First bump of the day" in body, True)
    check("stops at the released version", "Already released" in body, False)
    check("asked about 1.2.1 before 1.2.0", seen[:2], ["1.2.1", "1.2.0"])

    print("notes never trusts a boundary this changelog does not list")
    # a phantom version — the shape of a real risk: `gh release list` sorts by
    # created_at and does not exclude drafts/prereleases, so it can name a
    # version no changelog section was ever written for.
    out2 = tmp / "notes-phantom.md"
    code2 = release_notes.main(
        ["notes", str(config), str(changelog), "--write", str(out2)],
        is_released=lambda v: False,
    )
    check("exit code", code2, 0)
    body2 = text_of(out2)
    check("still carries every section", "Already released" in body2, True)

    print("notes refuses a config version the changelog never mentions")
    ghost = tmp / "config-ghost.yaml"
    ghost.write_text('name: "X"\nversion: "9.9.9"\n')
    code3 = release_notes.main(
        ["notes", str(ghost), str(changelog), "--write", str(tmp / "n3.md")],
        is_released=lambda v: False,
    )
    check("exit code", code3, 1)

    print("nothing pending (config version already has a release) refuses too")
    code4 = release_notes.main(
        ["notes", str(config), str(changelog), "--write", str(tmp / "n4.md")],
        is_released=lambda v: True,
    )
    check("exit code", code4, 1)


def fake_gh(bin_dir: pathlib.Path, exit_code: int, stderr: str) -> None:
    """A `gh` on PATH that answers `release view` with the given exit and stderr."""
    script = bin_dir / "gh"
    script.write_text(f"#!/bin/sh\nprintf '%s\\n' '{stderr}' >&2\nexit {exit_code}\n")
    script.chmod(0o755)


def real_gh_run(bin_dir: pathlib.Path, *args: str) -> int:
    """release_notes.main with its own gh lookup, gh being the fake in bin_dir."""
    saved = os.environ["PATH"]
    os.environ["PATH"] = f"{bin_dir}{os.pathsep}{saved}"
    try:
        return release_notes.main(list(args))
    finally:
        os.environ["PATH"] = saved


with tempfile.TemporaryDirectory() as raw:
    tmp = pathlib.Path(raw)
    bin_dir = tmp / "bin"
    bin_dir.mkdir()
    config = tmp / "config.yaml"
    changelog = tmp / "CHANGELOG.md"
    config.write_text(CONFIG)
    changelog.write_text(CHANGELOG)

    print("a gh that is broken is an error, never 'no release yet'")
    # gh exits 1 for a missing release AND for a 401 or a refused connection,
    # so each broken shape below must be told apart from "release not found".
    for label, code, err in [
        ("bad token (exit 1)", 1, 'non-200 OK status code: 401 Unauthorized body: "Bad credentials"'),
        ("no network (exit 1)", 1, 'Get "https://api.github.com/x": connect: connection refused'),
        ("tool failure (exit 3)", 3, "something else went wrong"),
        ("silent failure (exit 3, no stderr)", 3, ""),
    ]:
        fake_gh(bin_dir, code, err)
        notes_out = tmp / "notes-broken.md"
        notes_out.unlink(missing_ok=True)
        check(f"notes fails: {label}", real_gh_run(bin_dir, "notes", str(config), str(changelog), "--write", str(notes_out)), 2)
        check(f"no notes written: {label}", notes_out.exists(), False)
        check(f"released says lookup failed: {label}", real_gh_run(bin_dir, "released", "1.2.1"), 2)

    print("gh's own answers still map to yes and no")
    fake_gh(bin_dir, 1, "release not found")
    check("release not found -> not released (exit 1)", real_gh_run(bin_dir, "released", "1.2.1"), 1)
    fake_gh(bin_dir, 0, "")
    check("release exists -> released (exit 0)", real_gh_run(bin_dir, "released", "1.2.1"), 0)

    print("notes through the real lookup, gh saying 'not found' for the two newest and 'exists' for the last")
    (bin_dir / "gh").write_text(
        "#!/bin/sh\n"
        'case "$3" in v1.1.9) exit 0;; *) echo "release not found" >&2; exit 1;; esac\n'
    )
    (bin_dir / "gh").chmod(0o755)
    notes_ok = tmp / "notes-ok.md"
    check("exit code", real_gh_run(bin_dir, "notes", str(config), str(changelog), "--write", str(notes_ok)), 0)
    check("carries both pending sections", ("Second bump" in notes_ok.read_text()) and ("First bump" in notes_ok.read_text()), True)
    check("stops at the released one", "Already released" in notes_ok.read_text(), False)

with tempfile.TemporaryDirectory() as raw:
    repo = pathlib.Path(raw)

    def git(*args: str, date: str | None = None) -> None:
        env = dict(os.environ)
        if date:
            env["GIT_COMMITTER_DATE"] = date
            env["GIT_AUTHOR_DATE"] = date
        subprocess.run(
            ["git", "-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false", *args],
            cwd=repo, env=env, check=True, capture_output=True,
        )

    git("init", "-q")
    cfg = repo / "config.yaml"
    cfg.write_text('name: "X"\nversion: "1.2.0"\n')
    git("add", ".")
    git("commit", "-q", "-m", "first", date="2026-09-01T10:00:00Z")
    cfg.write_text('name: "X"\nversion: "1.2.1"\n')
    git("commit", "-qam", "bump", date="2026-09-02T10:00:00Z")
    cfg.write_text('name: "Y"\nversion: "1.2.1"\n')
    git("commit", "-qam", "unrelated edit after the bump", date="2026-09-03T10:00:00Z")

    print("pending-since names the commit that put the version there, not the last edit")
    bump_time = int(datetime.datetime(2026, 9, 2, 10, tzinfo=datetime.timezone.utc).timestamp())
    check("time of the bump", release_notes.pending_since(cfg), bump_time)
    check("command exits 0", release_notes.main(["pending-since", str(cfg)]), 0)
    cfg.write_text('name: "Y"\nversion: "1.99.0"\n')
    check("a version git never committed has no time", release_notes.pending_since(cfg), None)
    check("and the command exits 1", release_notes.main(["pending-since", str(cfg)]), 1)

print("the real files of this repository, not a fixture")
real_config = (REPO / "codex/config.yaml").read_text(encoding="utf-8")
real_changelog = (REPO / "codex/CHANGELOG.md").read_text(encoding="utf-8")
real_sections = release_notes.parse_changelog_sections(real_changelog)
check("the changelog parses into sections at all", len(real_sections) >= 2, True)
check(
    "its top section is the version config.yaml declares",
    real_sections[0][0] if real_sections else None,
    release_notes.parse_config_version(real_config),
)
check(
    "sections are ordered newest first",
    [tuple(int(p) for p in v.split(".")) for v, _ in real_sections]
    == sorted((tuple(int(p) for p in v.split(".")) for v, _ in real_sections), reverse=True),
    True,
)
check(
    "a section carries its own body, not just the heading",
    len(real_sections[0][1].splitlines()) > 1 if real_sections else False,
    True,
)

print(f"\n{'FAILED' if fails else 'ok'} — {fails} failing check(s)")
sys.exit(1 if fails else 0)
