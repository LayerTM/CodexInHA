#!/usr/bin/env python3
"""The add-on store's entry conditions, asserted on this repository's root.

A user does not install an add-on file by file: they paste this repository's URL
into the add-on store. Before a single line of the add-on is read, Home
Assistant clones the repository and asks whether the clone is a store at all. A
"no" deletes the clone again with "<url> is not a valid app repository", and the
add-on's own config.yaml — which every other check here lints — is never
reached. That is a failure only a user who installs from the URL can see, and
none of the per-add-on linters can: they are handed the add-on directory.

The rule this asserts is the Supervisor's own (supervisor/store/repository.py,
supervisor/store/validate.py, read at 2026.09.0): a `repository.yaml`,
`repository.yml` or `repository.json` at the root, parsing to a mapping with a
required `name`, an optional `url` that is a URL and an optional `maintainer`.

The second condition below is ours, not the Supervisor's: a repository with no
add-on in it passes that validation and then offers the user nothing to install.
It is discovered the way the Supervisor discovers add-ons (store/data.py): every
`config.yaml`/`.yml`/`.json` under the root whose path contains no dot-prefixed
part and no `rootfs` part.

FAIL CLOSED, and in two different ways, because "I could not look" and "I looked
and it is wrong" are not the same answer. A root or a file the check cannot READ
(an OSError, bytes that are not UTF-8) ends the check: exit 2. A file it read and
found wanting — missing, not a mapping, no `name`, malformed YAML or JSON — is a
finding about the repository: exit 1. Neither shares an exit code with success.

Usage:
    python .github/scripts/store_repository_check.py [path]   # default: .
Exit: 0 valid, 1 findings, 2 the check could not be performed.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

import yaml

# supervisor/const.py: FILE_SUFFIX_CONFIGURATION
CONFIG_SUFFIXES = (".yaml", ".yml", ".json")


def load_config_file(path: Path) -> Any:
    """Read a YAML or JSON configuration file the way the Supervisor reads one."""
    text = path.read_text(encoding="utf-8")
    if path.suffix == ".json":
        return json.loads(text)
    return yaml.safe_load(text)


class CannotCheck(Exception):
    """The check could not be performed — never confused with a clean result."""


def check_repository_file(root: Path) -> list[str]:
    """Apply the Supervisor's validation of the repository file.

    Raises CannotCheck when the file exists but cannot be read at all.
    """
    for suffix in CONFIG_SUFFIXES:
        candidate = root / f"repository{suffix}"
        if candidate.exists():
            break
    else:
        return [
            "no repository.yaml / repository.yml / repository.json at the root: "
            "the add-on store refuses the repository before reading any add-on"
        ]

    try:
        config = load_config_file(candidate)
    except (OSError, UnicodeDecodeError) as err:
        raise CannotCheck(f"{candidate.name} cannot be read: {err}") from err
    except (yaml.YAMLError, json.JSONDecodeError) as err:
        return [f"{candidate.name}: is not valid YAML or JSON: {err}"]

    if not isinstance(config, dict):
        return [f"{candidate.name}: must be a mapping, got {type(config).__name__}"]

    findings: list[str] = []
    name = config.get("name")
    if not isinstance(name, str) or not name:
        findings.append(f"{candidate.name}: `name` is required and must be a string")

    url = config.get("url")
    if url is not None:
        parsed = urlparse(url) if isinstance(url, str) else None
        if parsed is None or not parsed.scheme or not parsed.netloc:
            findings.append(f"{candidate.name}: `url` must be a URL")

    maintainer = config.get("maintainer")
    if maintainer is not None and not isinstance(maintainer, str):
        findings.append(f"{candidate.name}: `maintainer` must be a string")

    return findings


def find_addons(root: Path) -> list[Path]:
    """Find the add-ons the store would offer, as the Supervisor finds them."""
    return sorted(
        config
        for config in root.glob("**/config.*")
        if config.suffix in CONFIG_SUFFIXES
        and not [
            part
            for part in config.relative_to(root).parts
            if part.startswith(".") or part == "rootfs"
        ]
    )


def main(argv: list[str]) -> int:
    root = Path(argv[1] if len(argv) > 1 else ".").resolve()
    if not root.is_dir():
        print(f"store-repository: {root} is not a directory", file=sys.stderr)
        return 2

    try:
        findings = check_repository_file(root)
        addons = find_addons(root)
    except (OSError, CannotCheck) as err:
        print(f"store-repository: cannot scan {root}: {err}", file=sys.stderr)
        return 2

    if not addons:
        findings.append(
            "no add-on found: the store would show an empty repository to the user"
        )

    if findings:
        for finding in findings:
            print(f"store-repository: {finding}")
        return 1

    names = ", ".join(str(config.parent.relative_to(root)) for config in addons)
    print(f"store-repository: {root.name} is a valid add-on store ({names})")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
