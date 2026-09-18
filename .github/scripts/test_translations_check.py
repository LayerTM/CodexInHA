#!/usr/bin/env python3
"""Self-test for translations_check — each way of falling behind fails on its own.

Every case builds a small add-on directory in a temporary place, so a check that
stopped looking (always returning "complete") fails here. The first case is the
shape this repository had: an option in the schema that no language names.

Run: python .github/scripts/test_translations_check.py   (exit 0 = pass, 1 = fail)
No test framework required.
"""

from __future__ import annotations

import sys
import tempfile
from pathlib import Path

from translations_check import main

SCHEMA = 'name: "Codex"\nslug: codex\nschema:\n  api_key: "password?"\n  model: str?\n'
BOTH = """configuration:
  api_key:
    name: API Key
    description: A key.
  model:
    name: Model
    description: A model.
"""
ONE = """configuration:
  api_key:
    name: API Key
    description: A key.
"""
NO_DESCRIPTION = """configuration:
  api_key:
    name: API Key
    description: A key.
  model:
    name: Model
"""
EMPTY_DESCRIPTION = """configuration:
  api_key:
    name: API Key
    description: A key.
  model:
    name: Model
    description: "  "
"""
UNCLOSED_QUOTE = """configuration:
  api_key:
    name: API Key
    description: Leave empty to use the \u201eModel" above.
  model:
    name: Model
    description: A model.
"""
CLOSED_QUOTE = """configuration:
  api_key:
    name: API Key
    description: Leave empty to use the \u201eModel\u201d above.
  model:
    name: Model
    description: A model.
"""
UNKNOWN = BOTH + """  gone:
    name: Removed
    description: An option that no longer exists.
"""


def build(root: Path, config: str, files: dict[str, str]) -> Path:
    """Lay out an add-on directory: a config.yaml and its translations."""
    addon = root / "codex"
    (addon / "translations").mkdir(parents=True)
    (addon / "config.yaml").write_text(config, encoding="utf-8")
    for lang, text in files.items():
        (addon / "translations" / f"{lang}.yaml").write_text(text, encoding="utf-8")
    return addon


# (case, config.yaml, {language: file}, expected exit)
CASES = [
    ("every option named in every language", SCHEMA, {"en": BOTH, "uk": BOTH}, 0),
    ("an option no language names", SCHEMA, {"en": ONE, "uk": ONE}, 1),
    ("one language behind the others", SCHEMA, {"en": BOTH, "uk": ONE}, 1),
    ("an option with a name but no description", SCHEMA, {"en": NO_DESCRIPTION}, 1),
    ("a description that is only whitespace", SCHEMA, {"en": EMPTY_DESCRIPTION}, 1),
    ("a described option that is not in the schema", SCHEMA, {"en": UNKNOWN}, 1),
    ("a quote that opens and never closes", SCHEMA, {"en": UNCLOSED_QUOTE}, 1),
    ("a quote that closes the way it opened", SCHEMA, {"en": CLOSED_QUOTE}, 0),
    ("a translation file with no configuration section", SCHEMA, {"en": "network:\n  8099: null\n"}, 1),
    ("a config.yaml with no schema", 'name: "Codex"\n', {"en": BOTH}, 2),
    ("a translation file that is not YAML", SCHEMA, {"en": "configuration: [\n"}, 2),
    ("no translation file at all", SCHEMA, {}, 2),
]


def run() -> int:
    failures = 0
    for case, config, files, expected in CASES:
        with tempfile.TemporaryDirectory() as tmp:
            addon = build(Path(tmp), config, files)
            actual = main(["translations_check.py", str(addon)])
        if actual != expected:
            print(f"FAIL: {case}: expected exit {expected}, got {actual}")
            failures += 1
        else:
            print(f"ok: {case} (exit {actual})")

    # A directory that is not there must be "could not check" (2), never "complete".
    with tempfile.TemporaryDirectory() as tmp:
        actual = main(["translations_check.py", str(Path(tmp) / "absent")])
    if actual != 2:
        print(f"FAIL: a missing add-on directory: expected exit 2, got {actual}")
        failures += 1
    else:
        print("ok: a missing add-on directory (exit 2)")

    if failures:
        print(f"{failures} case(s) failed")
        return 1
    print("all cases passed")
    return 0


if __name__ == "__main__":
    sys.exit(run())
