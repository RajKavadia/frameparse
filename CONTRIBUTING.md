# Contributing to FrameParse

Thanks for helping improve agent-friendly webpage observation.

## Development setup

```bash
git clone https://github.com/RajKavadia/frameparse.git
cd frameparse
npm install
npm run build
npm test
npm run benchmark   # optional: token/latency tables
```

Requires **Node.js ≥ 20**.

## Pull requests

1. Branch from `main` (e.g. `fix/action-tier-commerce`).
2. Keep changes focused; match existing TypeScript style in `src/`.
3. Run `npm test` before pushing.
4. Add or update tests in `tests/frameparse.test.ts` for behavior changes.
5. Update README or `docs/` when user-facing behavior changes.

## Good first issues

- False positives in Frame 4 action inference (especially destructive tier).
- Real-world HTML fixtures (anonymized) that break parsing.
- Docs and integration examples (Playwright, Puppeteer) — FrameParse outputs selectors; it does not ship a browser driver.
- npm publish ergonomics and path-independent `mcp.json` examples.

## Code of conduct

Be constructive. Report security concerns privately via GitHub Security Advisories on the repository.