#!/usr/bin/env python3
"""Self-test for store_repository_check — the check must fail for the reason it names.

Every case builds a repository root in a temporary directory and asserts the
verdict, so a check that stopped looking (always returning "valid") fails here.
The first case is the one measured against Home Assistant: this repository as it
was before `repository.yaml` existed.

Run: python .github/scripts/test_store_repository_check.py   (exit 0 = pass, 1 = fail)
No test framework required.
"""

from __future__ import annotations

import sys
import tempfile
from pathlib import Path

from store_repository_check import main

VALID_REPOSITORY = 'name: Codex for Home Assistant\nurl: https://example.com/x\nmaintainer: Someone\n'
ADDON_CONFIG = 'name: "Codex"\nversion: "0.1.0"\nslug: codex\n'


def build(root: Path, repository: str | None, addon: str | None) -> None:
    """Lay out a repository root: an optional repository file, an optional add-on."""
    if repository is not None:
        (root / "repository.yaml").write_text(repository, encoding="utf-8")
    if addon is not None:
        (root / "codex").mkdir()
        (root / "codex" / "config.yaml").write_text(addon, encoding="utf-8")


# (case, repository file contents or None, add-on config or None, expected exit)
CASES = [
    ("a store with one add-on", VALID_REPOSITORY, ADDON_CONFIG, 0),
    ("no repository file at all", None, ADDON_CONFIG, 1),
    ("repository file without a name", "url: https://example.com/x\n", ADDON_CONFIG, 1),
    ("name that is not a string", "name: 12\n", ADDON_CONFIG, 1),
    ("url that is not a URL", "name: Codex\nurl: example\n", ADDON_CONFIG, 1),
    ("repository file that is a list", "- name: Codex\n", ADDON_CONFIG, 1),
    ("repository file that is not YAML", "name: [unclosed\n", ADDON_CONFIG, 1),
    ("a store with no add-on in it", VALID_REPOSITORY, None, 1),
]


def run() -> int:
    failures = 0
    for case, repository, addon, expected in CASES:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            build(root, repository, addon)
            actual = main(["store_repository_check.py", str(root)])
        if actual != expected:
            print(f"FAIL: {case}: expected exit {expected}, got {actual}")
            failures += 1
        else:
            print(f"ok: {case} (exit {actual})")

    # A repository file the check cannot READ is "could not check" (2), never a
    # finding and never a pass: bytes that are not UTF-8 are not a wrong store,
    # they are a store nobody looked at.
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        build(root, None, ADDON_CONFIG)
        (root / "repository.yaml").write_bytes(b"name: \xff\xfe not utf-8\n")
        actual = main(["store_repository_check.py", str(root)])
    if actual != 2:
        print(f"FAIL: a repository file that cannot be decoded: expected exit 2, got {actual}")
        failures += 1
    else:
        print("ok: a repository file that cannot be decoded (exit 2)")

    # A root that does not exist must be "could not check" (2), never "valid".
    with tempfile.TemporaryDirectory() as tmp:
        missing = Path(tmp) / "absent"
        actual = main(["store_repository_check.py", str(missing)])
    if actual != 2:
        print(f"FAIL: a missing root: expected exit 2, got {actual}")
        failures += 1
    else:
        print("ok: a missing root (exit 2)")

    # An add-on's own files must not be mistaken for a second add-on: a
    # `config.yaml` under `rootfs/` or in a dot-directory is not one.
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        build(root, VALID_REPOSITORY, ADDON_CONFIG)
        (root / "codex" / "rootfs").mkdir()
        (root / "codex" / "rootfs" / "config.yaml").write_text("x: 1\n", encoding="utf-8")
        (root / ".github").mkdir()
        (root / ".github" / "config.yml").write_text("x: 1\n", encoding="utf-8")
        actual = main(["store_repository_check.py", str(root)])
    if actual != 0:
        print(f"FAIL: rootfs and dot-directory configs: expected exit 0, got {actual}")
        failures += 1
    else:
        print("ok: rootfs and dot-directory configs are not add-ons (exit 0)")

    if failures:
        print(f"{failures} case(s) failed")
        return 1
    print("all cases passed")
    return 0


if __name__ == "__main__":
    sys.exit(run())
