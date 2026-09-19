#!/usr/bin/env python3
"""Self-test for release_notes.py — what a release's notes carry when a cut
was skipped for one or more version bumps in a row, and that the heading form
this repository's changelog is actually written in is the one it reads.

Its value is in three places: the accumulation (a script that only ever took
the top changelog section would silently drop every bump superseded before its
own cut); where the boundary comes from (a boundary trusted from elsewhere
would drop just the same way whenever that source names a version this
changelog never had a section for); and the real file (a heading regex proved
only against a fixture can be wrong about the one changelog it will ever read).

Run: python3 .github/scripts/test_release_notes.py
"""

from __future__ import annotations

import pathlib
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
