<p align="center">
  <img src="./assets/logo.svg" alt="pi-noctalia logo" width="96" height="96" />
</p>

<h1 align="center">pi-noctalia</h1>

<p align="center">
  Internal tooling, context-engineering, semantic routing, and hybrid compaction suite for the <a href="https://github.com/earendil-works/pi">Pi</a> coding agent.
</p>

---

## Architecture Overview

`pi-noctalia` treats the agent context window as a finite resource rather than an append-only dump:

1. **Semantic Virtual Routing (`extensions/noctalia-router.ts`):**
   - Registers `router/auto` and `router/free`, dynamically scoring prompts across `task_kind`, `complexity`, and `deep_reasoning` with Pi's built-in non-autoregressive `$0` classifier (`opencode/jev-1.13-free`) via `ctx.modelRegistry.classify()`.
   - Strips harness-injected context (`<hindsight_*>`, `<system-reminder>`) so routing classifies only real human requests.
   - Preserves KV prompt-cache prefix warmth (`request.previous.model` stickiness + Claude `thinkingLevel` lock) across turns, breaking cache only on failover, manual `Tab` escalation to `high`+, or early-session architectural jumps (`< 24k` context tokens).
   - Captures non-retryable quota errors (`GoUsageLimitError`, `402`) on `turn_end` and persists provider reset cooldowns (`~/.pi/agent/router-cooldowns.json`).

2. **Two-Stage Hybrid Compaction (`extensions/noctalia-compaction.ts`):**
   - Intercepts `session_before_compact` instead of burning an expensive LLM pass on raw tool logs or using a rigid template that discards mid-message reasoning.
   - **Stage 1 (Observation Masking + `$0` Jev Filter):** Deterministically masks duplicate tool calls, pure acknowledgements, install spam, search dumps, and oversized re-readable file reads while batching ambiguous bulk tool outputs to `opencode/jev-1.13-free`. Outputs flagged `KEEP` by Jev and tool errors are preserved verbatim into `## Retained Tool Evidence (Verbatim)`.
   - **Stage 2 (Semantic Cascade Synthesis + Deterministic `fileOps`):** Feeds only the ~90% smaller signal transcript + `previousSummary` into the compaction cascade (`cacheRetention: "none"`), appending deterministic `<read-files>` and `<modified-files>` tags from `preparation.fileOps`.

3. **Workspace & Session Ergonomics:**
   - **Durable Tabs (`extensions/noctalia-tabs.ts`):** OpenCode-style workspace tab strip over Pi's append-only JSONL session trees (`/tabs`, `/tab-new`, `/tab-close`, `/tab-prev`, `/tab-next`, `/tab-go`, `/tab-rename`).
   - **Smart-Zone Handoff (`extensions/noctalia-handoff.ts`):** Intentional `/handoff <goal>` transfer into a linked clean session at 40–60% context before context rot sets in.
   - **Diagnostics Footer (`extensions/noctalia-status.ts`):** Compact status bar + `/info` telemetry (active route, Jev judgment, cache R/W, context fill bar, cost, last compaction metrics, provider cooldowns).
   - **Shell Guardrails (`extensions/noctalia-guardrails.ts`):** Pre-execution `tool_call` policy gate blocking destructive git/GH operations and failing closed on non-interactive `git push`.
   - **Wayland Ergonomics (`extensions/noctalia-ergo.ts`):** `/copy`, `/copy code`, and `/diff-copy` via `wl-copy` with zero model-context overhead.

---

## Measured Pre-Prune Benchmark

Reproducible run on a realistic 10-step mixed coding transcript (`npm install`, 95-line `grep`, duplicate 240-line `read`, remote JSON schema lookup rescued by Jev, noisy metrics curl dropped by Jev, file edit, and failing test trace):

```text
npm test   -> 10/10 passing (node --test test/*.test.ts, 84.7 ms)
npm run bench (100 iterations):
  perRunMs:     0.076 ms (deterministic pruning + verdict application)
  rawChars:     32,830 (~8,208 est. tokens)
  prunedChars:  3,185  (~797 est. tokens)
  reduction:    90.3%
  verdicts:     2 kept-verbatim (Jev rescue + error), 2 truncated, 3 dropped
  recall:       userGoal=true, failingError=true, jevRescuedPayload=true
```

---

## Install (Pi Package)

```bash
# Local development install
pi install /home/noorm/projects/pi-noctalia

# Or via GitHub once published
pi install git:github.com/DrMkdaddy/pi-noctalia
```

Requires Node.js >= 22 (tested on Node 26.13.0) and `@earendil-works/pi-coding-agent` (`pi` CLI). Optional Wayland clipboard helpers use `wl-copy`.

---

## Repository Layout

- [src/compaction-core.ts](src/compaction-core.ts) — Pure observation-masking, Jev `bool` question builder, and evidence-retaining renderer
- [src/router-core.ts](src/router-core.ts) — Hindsight/system injection stripper, quota cooldown parser, and difficulty mapper
- [src/guardrails-core.ts](src/guardrails-core.ts) — Shell policy evaluator
- [extensions/](extensions/) — Seven modular Pi extension entry points
- [test/](test/) — `node --test` unit suite (`10/10` passing)
- [bench/compaction-bench.mjs](bench/compaction-bench.mjs) — Deterministic compaction pruning & recall benchmark
- [assets/logo.svg](assets/logo.svg) — Geometric Noctalia brand mark
