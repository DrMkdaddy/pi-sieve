# Changelog

## 0.2.0 - 2026-11-15

- Fixed `ClassifierBoolAnswer` handling (`probability` field vs removed `choice` field) in both `sieve-router.ts` (`deep_reasoning`) and `src/compaction-core.ts` (`applyJevAnswers`), unlocking live `xhigh` routing and `0.82`/`0.06` Jev compaction verdicts.
- Added typed singleton runtime state (`src/runtime-state.ts`) removing raw `globalThis` string-key casts across router, compaction, and status extensions.
- Replaced unexported `@earendil-works/pi-coding-agent` compaction barrel helpers with tested pure `formatFileOpsXml` and `SYNTHESIS_SYSTEM_PROMPT` in `src/compaction-core.ts`; switched `ctx.thinkingLevel` in `sieve-status.ts` so `tsc --noEmit` passes with zero errors.
- Extracted testable `src/tabs-core.ts` & `src/status-core.ts`, expanded unit suite to `14/14` passing tests.
- Upgraded `bench/compaction-bench.mjs` to 3 multi-step coding corpora (`92.3%` aggregate reduction, `100%` recall) + 6-pass multi-compaction drift probe, plus added `bench/live-jev-bench.mjs` for live `opencode/jev-1.13-free` System One verification.
- Added `.github/workflows/ci.yml` (`tsc --noEmit`, `npm test`, `npm run bench`).

## 0.1.0 - 2026-11-15

Initial public release of the `@drmkdaddy/pi-sieve` internal engineering harness for Pi.
