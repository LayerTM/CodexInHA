#!/usr/bin/env python3
"""Every option the add-on accepts is explained, in every language it ships.

The Configuration tab is generated from `config.yaml`'s `schema`, and Home
Assistant labels each field from `translations/<lang>.yaml`. An option with no
entry there is still shown — as its raw key, with no explanation — so a field
nobody described looks like a bug in the add-on to the person setting it up.
Measured on this repository before this check existed: nine of forty-four
options (`alert_co2_above`, `alert_humidity_*`, `alert_offline*`,
`alert_temp_entities`, `quick_prompts`, `transcript_retention_days`) had no name
and no description in any of the three languages.

The schema is the oracle; the translations are checked against it, never against
each other, so adding an option is what makes this fail — in every language at
once, which is also how a language falls behind unnoticed.

A quotation mark is checked the same way: a text that opens a quote with a
typographic mark closes it with that mark's own partner. Measured on this
repository before this check existed: the Polish file opened nine quotes with
the Polish low mark and closed none of them — every one ended on a plain ASCII
double quote, so a Polish reader saw an unclosed quote in nine descriptions.

FAIL CLOSED: a file that cannot be read or parsed ends the check with 2. A file
read and found wanting is a finding: 1.

Usage:
    python .github/scripts/translations_check.py [addon-dir]   # default: codex
Exit: 0 complete, 1 findings, 2 the check could not be performed.
"""

from __future__ import annotations

import sys
from pathlib import Path

import yaml


# A quotation mark that opens has one partner that closes it. Grouped by closer,
# because Polish („…”) and English (“…”) share one. The single marks ’ and ‹…› are
# left out: ’ is an apostrophe in most of the languages this add-on ships in.
QUOTE_PAIRS = ((("„", "“"), "”"), (("«",), "»"))


class CannotCheck(Exception):
    """The check could not be performed — never confused with a clean result."""


def load(path: Path) -> dict:
    """Read one YAML file, or say the check cannot be performed."""
    try:
        data = yaml.safe_load(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, yaml.YAMLError) as err:
        raise CannotCheck(f"{path}: {err}") from err
    if not isinstance(data, dict):
        raise CannotCheck(f"{path}: expected a mapping at the top level")
    return data


def unclosed_quotes(lang: str, option: str, field: str, value: str) -> list[str]:
    """Say where a typographic quote opens in this text and never closes."""
    findings = []
    for openers, closer in QUOTE_PAIRS:
        opened = sum(value.count(mark) for mark in openers)
        closed = value.count(closer)
        if opened != closed:
            marks = "/".join(openers)
            findings.append(
                f"{lang}: `{option}` {field} opens {opened} {marks} and closes {closed} {closer}"
            )
    return findings


def check(addon: Path) -> list[str]:
    """Compare every translation file against the add-on's own option schema."""
    schema = load(addon / "config.yaml").get("schema")
    if not isinstance(schema, dict) or not schema:
        raise CannotCheck(f"{addon / 'config.yaml'}: no option schema to check against")

    translations = sorted((addon / "translations").glob("*.yaml"))
    if not translations:
        raise CannotCheck(f"{addon / 'translations'}: no translation files")

    findings: list[str] = []
    for path in translations:
        lang = path.stem
        configuration = load(path).get("configuration")
        if not isinstance(configuration, dict):
            findings.append(f"{lang}: no `configuration` section")
            continue
        for option in schema:
            entry = configuration.get(option)
            if not isinstance(entry, dict):
                findings.append(f"{lang}: `{option}` has no entry — the user sees the raw key")
                continue
            for field in ("name", "description"):
                value = entry.get(field)
                if not isinstance(value, str) or not value.strip():
                    findings.append(f"{lang}: `{option}` has no {field}")
                    continue
                findings.extend(unclosed_quotes(lang, option, field, value))
        for option in configuration:
            if option not in schema:
                findings.append(f"{lang}: `{option}` is described but is not an option")
    return findings


def main(argv: list[str]) -> int:
    addon = Path(argv[1] if len(argv) > 1 else "codex").resolve()
    if not addon.is_dir():
        print(f"translations: {addon} is not a directory", file=sys.stderr)
        return 2

    try:
        findings = check(addon)
    except CannotCheck as err:
        print(f"translations: cannot check {addon}: {err}", file=sys.stderr)
        return 2

    if findings:
        for finding in findings:
            print(f"translations: {finding}")
        return 1

    print(f"translations: every option of {addon.name} is named and described in every language")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
