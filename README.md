<p align="center">
  <img src="./assets/logo.svg" alt="pi-sieve logo" width="96" height="96" />
</p>

<h1 align="center">pi-sieve</h1>

<p align="center">
  Internal tooling, context-engineering, semantic routing, and hybrid compaction suite for the <a href="https://github.com/earendil-works/pi">Pi</a> coding agent.
</p>

---

## Architecture Overview

`pi-sieve` treats the agent context window as a finite resource rather than an append-only dump:

1. **Semantic Virtual Routing (`extensions/sieve-router.ts`):**
   - Registers `router/auto` and `router/free`, dynamically scoring prompts across `task_kind`, `complexity`, and `deep_reasoning` with Pi's built-in non-autoregressive `$0` classifier (`opencode/jev-1.13-free`) via `ctx.modelRegistry.classify()`.
   - Strips harness-injected context (`<hindsight_*>`, `<system-reminder>`) so routing classifies only real human requests.
   - Preserves KV prompt-cache prefix warmth (`request.previous.model` stickiness + Claude `thinkingLevel` lock) across turns, breaking cache only on failover, manual `Tab` escalation to `high`+, or early-session architectural jumps (`< 24k` context tokens).
   - Captures non-retryable quota errors (`GoUsageLimitError`, `402`) on `turn_end` and persists provider reset cooldowns (`~/.pi/agent/router-cooldowns.json`).

2. **Two-Stage Hybrid Compaction (`extensions/sieve-compaction.ts`):**
   - Intercepts `session_before_compact` instead of burning an expensive LLM pass on raw tool logs or relying on a rigid template that discards mid-message reasoning.
   - **Stage 1 (Observation Masking + `$0` Jev Filter):** Deterministically masks duplicate tool calls, pure acknowledgements, install spam, search dumps, and oversized re-readable file reads while batching ambiguous bulk tool outputs to `opencode/jev-1.13-free`. Outputs flagged `KEEP` by Jev and tool errors are preserved verbatim into `## Retained Tool Evidence (Verbatim)`.
   - **Stage 2 (Semantic Cascade Synthesis + Deterministic `fileOps`):** Feeds only the pre-pruned signal transcript + `previousSummary` into the compaction cascade (`cacheRetention: "none"`), appending deterministic `<read-files>` and `<modified-files>` blocks from `preparation.fileOps`.

3. **Workspace & Session Ergonomics:**
   - **Durable Tabs (`extensions/sieve-tabs.ts`):** OpenCode-style workspace tab strip over Pi's append-only JSONL session trees (`/tabs`, `/tab-new`, `/tab-close`, `/tab-prev`, `/tab-next`, `/tab-go`, `/tab-rename`).
   - **Smart-Zone Handoff (`extensions/sieve-handoff.ts`):** Intentional `/handoff <goal>` transfer into a linked clean session at 40–60% context before context rot sets in.
   - **Diagnostics Footer (`extensions/sieve-status.ts`):** Compact status bar + `/info` telemetry (active route, Jev judgment, cache R/W, context fill bar, cost, last compaction metrics, provider cooldowns).
   - **Shell Guardrails (`extensions/sieve-guardrails.ts`):** Pre-execution `tool_call` policy gate blocking destructive git/GH operations and failing closed on non-interactive `git push`.
   - **Wayland Ergonomics (`extensions/sieve-ergo.ts`):** `/copy`, `/copy code`, and `/diff-copy` via `wl-copy` with zero model-context overhead.

---

## Verified Benchmarks & Checks

### 1. Deterministic Stage 1 Multi-Corpus & Multi-Pass Stability (`npm run bench`)

Across three distinct engineering session corpora (webhook HMAC migration + error trace, monorepo SQLite/Cargo/Go build triage, and bounded streaming parser file-read churn):

| Corpus | Raw Chars | Pruned Chars | Reduction | Per-Run Time | Critical Recall (`goal` / `error` / `rescued`) |
| --- | ---: | ---: | ---: | ---: | --- |
| `webhook-migration-and-error` | 32,779 | 3,158 | **90.4%** | 0.107 ms | `true / true / true` |
| `monorepo-search-build-triage` | 10,989 | 1,520 | **86.2%** | 0.039 ms | `true / true / true` |
| `long-file-read-churn` | 40,210 | 1,822 | **95.5%** | 0.018 ms | `true / true / true` |
| **Aggregate (3 sessions)** | **83,978** | **6,500** | **92.3%** | **< 0.11 ms** | **100% preserved** |

- **6-pass re-compaction stability probe:** Prompt length bounded deterministically (`813 → 903` chars across 6 sequential compactions, `boundedGrowth: true`).

### 2. Live `opencode/jev-1.13-free` System One Probes (`npm run bench:live`)

Measured live over Pi's `ModelRegistry.classify()`:

- **Routing classification (`$0` cost):**
  - Trivial HTTP lookup: `308 ms` → `explain / trivial` → `thinking: low`
  - Bounded fetch-retry implementation: `183 ms` → `implement / standard` → `thinking: medium`
  - Multi-region Postgres distributed lock architecture: `710 ms` → `plan / architectural` (`deepReasoning: true`) → `thinking: xhigh`
- **Compaction evidence filtering (`$0` cost, `332 ms` batch):**
  - Remote webhook schema lookup (`curl`): `probability: 0.82` → **rescued verbatim (`keep-verbatim`)**
  - Verbose `/healthz` metrics curl: `probability: 0.06` → **dropped as noise**

### 3. Typecheck & Unit Suite

- Strict TypeScript check (`npx tsc --noEmit`): `0` errors
- Node native test runner (`npm test`): `14/14` unit tests passing (`src/` + `test/`)

---

## Install (Pi Package)

```bash
# Via GitHub
pi install git:github.com/DrMkdaddy/pi-sieve

# Or local checkout
pi install /home/noorm/projects/pi-sieve
```

Requires Node.js >= 22 (tested on Node 26.13.0) and `@earendil-works/pi-coding-agent` (`pi` CLI). Optional Wayland clipboard helpers use `wl-copy`.
