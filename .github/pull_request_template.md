## Summary

<!-- What does this change and why? -->

## Related issue

<!-- e.g. #123 -->

## Checklist

- [ ] The tests pass in a plain checkout: `cd codex/app && node --test test/`
- [ ] Lint and types pass on the assembled tree — `npm run lint` and
      `npm run typecheck` need the dependencies that arrive with the core, so
      they run after the three commands in the README's *Building and testing*
- [ ] `python .github/scripts/secret_scan.py .` and `python .github/scripts/hygiene_scan.py .` are clean
- [ ] `CHANGELOG.md` updated if behaviour changed
