# Changelog

## 0.3.0 - 2026-11-15

- Added multi-provider System One / Decision classifier adapter layer (`src/classifier-adapter.ts`) supporting TypeSafe Jev (`opencode`, `openrouter`, `cloudflare-workers-ai`, `typesafe`, `vercel-ai-gateway`), Cloudflare Clef (`clef-flash`, `clef`, `clef-omni`), OpenAI `gpt-6-luna`, GitHub Copilot `microsoft-decision-1`, local `llama.cpp` Decision models (`OpenJev`, `Laya`, `Kev`, `Julia-1`), and direct `/v1/systemone` endpoints (`PI_SIEVE_SYSTEMONE_URL`).
- Added user config loader (`src/config.ts`, `examples/pi-sieve.example.json`) plus universal chat model fallback (`selectModelFromCascades`) so `pi-sieve` works out-of-the-box with any Pi provider.
- Added `/sieve-classifier`, `/sieve-doctor`, and cross-platform clipboard support (`src/clipboard-core.ts`: Wayland `wl-copy`, X11 `xclip`/`xsel`, macOS `pbcopy`).
- Expanded unit test suite to `19/19` passing tests and documented full prerequisites & provider auth matrix in `README.md`.

## 0.2.0 - 2026-11-15

- Fixed `ClassifierBoolAnswer` handling (`probability` field vs removed `choice` field) in both `sieve-router.ts` (`deep_reasoning`) and `src/compaction-core.ts` (`applyJevAnswers`), unlocking live `xhigh` routing and `0.82`/`0.06` Jev compaction verdicts.
- Added typed singleton runtime state (`src/runtime-state.ts`) removing raw `globalThis` string-key casts across router, compaction, and status extensions.
- Replaced unexported `@earendil-works/pi-coding-agent` compaction barrel helpers with tested pure `formatFileOpsXml` and `SYNTHESIS_SYSTEM_PROMPT` in `src/compaction-core.ts`; switched `ctx.thinkingLevel` in `sieve-status.ts` so `tsc --noEmit` passes with zero errors.
- Extracted testable `src/tabs-core.ts` & `src/status-core.ts`, expanded unit suite to `14/14` passing tests.
- Upgraded `bench/compaction-bench.mjs` to 3 multi-step coding corpora (`92.3%` aggregate reduction, `100%` recall) + 6-pass multi-compaction drift probe, plus added `bench/live-jev-bench.mjs` for live `opencode/jev-1.13-free` System One verification.
- Added `.github/workflows/ci.yml` (`tsc --noEmit`, `npm test`, `npm run bench`).

## 0.1.0 - 2026-11-15

Initial public release of the `@drmkdaddy/pi-sieve` internal engineering harness for Pi.
