<p align="center">
  <img src="./assets/logo.svg" alt="pi-sieve logo" width="96" height="96" />
</p>

<h1 align="center">pi-sieve</h1>

<p align="center">
  Internal tooling, semantic routing, hybrid Jev/Clef compaction, durable tabs, and guardrail suite for the <a href="https://github.com/earendil-works/pi">Pi</a> coding agent.
</p>

---

## Suite Architecture (Split by Concern) & How to Read This Repo

The Pi efficiency suite is split into three focused, standalone packages with zero cross-package runtime dependencies:

- **`pi-sieve` (this repo):** Semantic model cascades, `$0` System One classification (`Jev`, `Clef`, `GPT-6 Luna`), two-stage compaction pre-pruning, durable session tabs, `/handoff`, and shell guardrails.
- **[`pi-vault`](https://github.com/DrMkdaddy/pi-vault):** Persistent SQLite (`WAL` + `FTS5` + `zstd`) artifact store, supersession tracking, compaction DAG, and append-only verbatim recall tools (`vault_search`, `vault_expand`, `vault_dag`).
- **[`pi-codemap`](https://github.com/DrMkdaddy/pi-codemap):** Code-reading token reduction (`read_outline`, `read_symbol`, unbounded whole-file `read` outlining, session hash dedupe/diffs, and search noise pruning).

### Directory Reading Guide (`pi-sieve`)

Pure logic sits in `src/` (tested standalone in `test/` with zero Pi SDK runtime needed); `extensions/` binds pure modules to Pi lifecycle hooks:

```text
pi-sieve/
├── src/
│   ├── classifier-adapter.ts  # 1. System One adapter cascade (Jev, Clef, Luna, Copilot, llama.cpp HTTP)
│   ├── router-core.ts         # 2. Cascade lists (COMPACTION/FAST/PRO/FREE), KV stickiness & quota cooldowns
│   ├── compaction-core.ts     # 3. Deterministic observation masking, Jev batch rescue & fileOps XML
│   ├── config.ts              # 4. ~/.pi/agent/pi-sieve.json & PI_SIEVE_CONFIG loader
│   ├── runtime-state.ts       # 5. Process-wide typed singleton shared across footer/router/compaction
│   ├── guardrails-core.ts     # 6. Destructive shell command & git push fail-closed policy
│   ├── tabs-core.ts           # 7. Tab title normalization & workspace hash helpers
│   ├── status-core.ts         # 8. Footer meter & token scaling formatters
│   └── clipboard-core.ts      # 9. Wayland/X11/macOS clipboard backend detection
├── extensions/                # 10. Thin Pi event hooks binding src/ modules
├── test/                      # 11. Unit & adapter config tests (node --test)
└── bench/                     # 12. Deterministic multi-corpus & live Jev benchmark scripts
```

Recommended reading order: `src/router-core.ts` -> `src/classifier-adapter.ts` -> `src/compaction-core.ts` -> `extensions/sieve-router.ts` & `extensions/sieve-compaction.ts`.

---

## Requirements & Quickstart

### Prerequisites
- **Node.js `>= 22.18`** (native `.ts` type-stripping; tested on Node `26.13.0`)
- **[Pi coding agent CLI](https://github.com/earendil-works/pi)** (`npm i -g @earendil-works/pi-coding-agent`, tested on `1.5.2`)
- **At least one configured chat model provider in Pi** (`/login` or `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `OPENROUTER_API_KEY`, `GEMINI_API_KEY`, etc.)
- **Optional (recommended) System One / Decision classifier** for `$0`/fast semantic routing & compaction rescue — if none is configured, `pi-sieve` falls back cleanly to deterministic heuristics.
- **Optional clipboard CLI** for `/copy` & `/diff-copy`: `wl-clipboard` (Wayland), `xclip` or `xsel` (X11), or `pbcopy` (macOS built-in).

### Install

```bash
pi install git:github.com/DrMkdaddy/pi-sieve
```

Then run `/sieve-doctor` inside Pi to verify your detected classifiers, model pool, config file, and clipboard backend.

---

## Supported System One / Decision Classifier Adapters

`sieve-router` and `sieve-compaction` automatically detect and cascade across every Decision/System One classifier supported by Pi (`ctx.modelRegistry.getAvailableOfType("classifier")`), plus an optional self-hosted HTTP `/v1/systemone` endpoint:

| Family | Provider | Model ID(s) | Required Auth / Setup |
| --- | --- | --- | --- |
| **TypeSafe Jev (Free)** | `opencode` | `jev-1.13-free` | `OPENCODE_API_KEY` or `/login` (`$0` free tier) |
| **Cloudflare Clef** | `cloudflare-workers-ai` | `@cf/cloudflare/clef-flash`, `@cf/cloudflare/clef`, `@cf/cloudflare/clef-omni` | `CLOUDFLARE_API_KEY` + `CLOUDFLARE_ACCOUNT_ID` |
| **OpenRouter Clef & Jev** | `openrouter` | `cloudflare/clef-flash`, `cloudflare/clef`, `typesafe/jev-1.14`, `typesafe/jev-1.13` | `OPENROUTER_API_KEY` or `/login` |
| **Workers AI Jev** | `cloudflare-workers-ai` | `typesafe/jev-1.14.0`, `typesafe/jev` | `CLOUDFLARE_API_KEY` + `CLOUDFLARE_ACCOUNT_ID` |
| **TypeSafe Direct** | `typesafe` | `jev-latest` | `TYPESAFE_API_KEY` |
| **Vercel AI Gateway** | `vercel-ai-gateway` | `typesafe-ai/jev` | `AI_GATEWAY_API_KEY` |
| **OpenAI Decisions** | `openai` | `gpt-6-luna` | `OPENAI_API_KEY` (API key; not ChatGPT OAuth) |
| **GitHub Copilot** | `github-copilot` | `microsoft-decision-1` | `COPILOT_GITHUB_TOKEN` or `/login` |
| **Local `llama.cpp` / `laya-serve`** | `llama.cpp` or `systemone-http` | `OpenJev`, `Laya`, `Kev`, `Julia-1`, `lev` | Pi `llama.cpp` config or `PI_SIEVE_SYSTEMONE_URL` |

Switch or inspect adapters live inside a session:

```text
/sieve-classifier                              # show active pin & all detected classifiers
/sieve-classifier cloudflare-workers-ai/@cf/cloudflare/clef-flash
/sieve-classifier auto                         # restore automatic cascade order
/sieve-doctor                                  # verify config, classifiers, chat pool, clipboard
```

---

## Custom Cascades & Local Configuration

Copy [examples/pi-sieve.example.json](examples/pi-sieve.example.json) to `~/.pi/agent/pi-sieve.json` (or point `PI_SIEVE_CONFIG` at a custom file) to customize model priorities, pin a default classifier, or point at a local `/v1/systemone` server:

```json
{
  "classifier": "auto",
  "autoThinking": true,
  "systemOne": {
    "url": "http://127.0.0.1:8080/v1/systemone",
    "model": "openjev"
  },
  "cascades": {
    "fast": [
      { "provider": "anthropic", "id": "claude-sonnet-4-5" },
      { "provider": "openai", "id": "gpt-4.1" }
    ],
    "pro": [
      { "provider": "anthropic", "id": "claude-opus-4-5" },
      { "provider": "openai", "id": "o3" }
    ]
  }
}
```

Even without `pi-sieve.json`, if your setup lacks the default provider IDs, `selectModelFromCascades` falls back automatically to your available configured chat models ranked by reasoning capability and cost—no dead-end errors.

---

## Architecture Overview

1. **Semantic Virtual Routing (`extensions/sieve-router.ts`):**
   - Registers `router/auto` and `router/free`, dynamically scoring prompts across `task_kind`, `complexity`, and `deep_reasoning` via the System One adapter chain (`src/classifier-adapter.ts`).
   - Strips harness-injected context (`<hindsight_*>`, `<system-reminder>`) so routing classifies only real human requests.
   - Preserves KV prompt-cache prefix warmth (`request.previous.model` stickiness + Claude `thinkingLevel` lock) across turns, breaking cache only on failover, manual `Tab` escalation to `high`+, or early-session architectural jumps (`< 24k` context tokens).
   - Captures non-retryable quota errors (`GoUsageLimitError`, `402`) on `turn_end` and persists provider reset cooldowns (`~/.pi/agent/router-cooldowns.json`).

2. **Two-Stage Hybrid Compaction (`extensions/sieve-compaction.ts`):**
   - **Stage 1 (Observation Masking + Classifier Evidence Rescue):** Deterministically masks duplicate tool calls, pure acknowledgements, install spam, search dumps, and oversized re-readable file reads while batching ambiguous bulk tool outputs to your active System One classifier (`jev-1.13-free`, `clef-flash`, `gpt-6-luna`, etc.). Steps scored keep-worthy and tool errors are promoted into `## Retained Tool Evidence (Verbatim)`.
   - **Stage 2 (Semantic Cascade Synthesis + Deterministic `fileOps`):** Feeds only the pruned signal transcript + `previousSummary` into the compaction cascade (`cacheRetention: "none"`), appending deterministic `<read-files>` and `<modified-files>` blocks from `preparation.fileOps`.

3. **Workspace & Session Ergonomics:**
   - **Durable Tabs (`extensions/sieve-tabs.ts`):** Workspace tab strip over Pi's JSONL session trees (`/tabs`, `/tab-new`, `/tab-close`, `/tab-prev`, `/tab-next`, `/tab-go`, `/tab-rename`).
   - **Smart-Zone Handoff (`extensions/sieve-handoff.ts`):** Intentional `/handoff <goal>` transfer into a linked clean session at 40–60% context.
   - **Diagnostics Footer (`extensions/sieve-status.ts`):** Status bar + `/info` + `/sieve-doctor`.
   - **Shell Guardrails (`extensions/sieve-guardrails.ts`):** Pre-execution `tool_call` bash policy gate blocking destructive git/GH commands and failing closed on unattended `git push`.
   - **Cross-Platform Ergonomics (`extensions/sieve-ergo.ts`):** `/copy`, `/copy code`, and `/diff-copy` across Wayland, X11, and macOS.

---

## Verified Benchmarks & Checks

### 1. Deterministic Stage 1 Multi-Corpus & Multi-Pass Stability (`npm run bench`)

| Corpus | Raw Chars | Pruned Chars | Reduction | Per-Run Time | Critical Recall (`goal` / `error` / `rescued`) |
| --- | ---: | ---: | ---: | ---: | --- |
| `webhook-migration-and-error` | 32,779 | 3,158 | **90.4%** | 0.165 ms | `true / true / true` |
| `monorepo-search-build-triage` | 10,989 | 1,520 | **86.2%** | 0.039 ms | `true / true / true` |
| `long-file-read-churn` | 40,210 | 1,822 | **95.5%** | 0.019 ms | `true / true / true` |
| **Aggregate (3 sessions)** | **83,978** | **6,500** | **92.3%** | **< 0.17 ms** | **100% preserved** |

- **6-pass re-compaction stability probe:** Prompt length bounded deterministically (`813 → 903` chars across 6 sequential compactions, `boundedGrowth: true`).

### 2. Live `opencode/jev-1.13-free` System One Probes (`npm run bench:live`)

- **Routing classification (`$0` cost):**
  - Trivial HTTP lookup: `308 ms` → `explain / trivial` → `thinking: low`
  - Bounded fetch-retry implementation: `183 ms` → `implement / standard` → `thinking: medium`
  - Multi-region Postgres distributed lock architecture: `710 ms` → `plan / architectural` (`deepReasoning: true`) → `thinking: xhigh`
- **Compaction evidence filtering (`$0` cost, `332 ms` batch):**
  - Remote webhook schema lookup (`curl`): `probability: 0.82` → **rescued verbatim (`keep-verbatim`)**
  - Verbose `/healthz` metrics curl: `probability: 0.06` → **dropped as noise**

### 3. Typecheck, Tests & CI
- `npm run typecheck` (`tsc --noEmit`): `0` errors
- `npm test`: `19/19` unit tests passing (`node --test test/*.test.ts`)
- GitHub Actions CI (`.github/workflows/ci.yml`): runs strict `tsc`, unit tests, and benchmarks on every push to `dev` and `main`.
