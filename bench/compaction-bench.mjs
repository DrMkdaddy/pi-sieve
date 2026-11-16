/**
 * Multi-corpus deterministic compaction pre-filter benchmark + 6-pass convergence probe.
 * Measures pruning latency, payload reduction, and 100% retention of critical facts
 * (user constraints, tool errors, Jev-rescued payloads) across diverse session shapes.
 */
import { performance } from "node:perf_hooks";
import {
	applyJevAnswers,
	buildHybridSynthesisPrompt,
	normalizeSteps,
	pruneStepsDeterministic,
	renderPrunedResult,
	resolveRemainingAsks,
} from "../src/compaction-core.ts";

function sessionWebhookMigration() {
	return {
		name: "webhook-migration-and-error",
		expectGoal: "constant-time HMAC",
		expectError: "rejects expired X-Webhook-Sig-V3 timestamp",
		expectRescued: "X-Webhook-Sig-V3",
		messages: [
			{ role: "user", content: "Migrate the billing webhook verifier to constant-time HMAC and preserve retry idempotency." },
			{
				role: "assistant",
				content: [
					{ type: "text", text: "Installing dependencies and inspecting verifier references." },
					{ type: "toolCall", id: "t1", name: "bash", arguments: { command: "npm install" } },
				],
			},
			{
				role: "toolResult",
				toolCallId: "t1",
				toolName: "bash",
				content: `${Array.from({ length: 160 }, (_, i) => `added pkg-${i}@1.2.${i} in 12ms`).join("\n")}\nadded 160 packages in 2.4s`,
			},
			{ role: "assistant", content: [{ type: "toolCall", id: "t2", name: "grep", arguments: { pattern: "verifyWebhook" } }] },
			{
				role: "toolResult",
				toolCallId: "t2",
				toolName: "bash",
				content: Array.from({ length: 95 }, (_, i) => `src/routes/r${i}.ts:${i + 1}: verifyWebhook(req)`).join("\n"),
			},
			{ role: "assistant", content: [{ type: "toolCall", id: "t3", name: "read", arguments: { path: "src/billing/webhook.ts" } }] },
			{
				role: "toolResult",
				toolCallId: "t3",
				toolName: "read",
				content: Array.from({ length: 240 }, (_, i) => `export function line${i}() { return ${i}; }`).join("\n"),
			},
			{ role: "assistant", content: [{ type: "toolCall", id: "t4", name: "read", arguments: { path: "src/billing/webhook.ts" } }] },
			{
				role: "toolResult",
				toolCallId: "t4",
				toolName: "read",
				content: Array.from({ length: 240 }, (_, i) => `export function line${i}() { return ${i}; }`).join("\n"),
			},
			{ role: "assistant", content: [{ type: "toolCall", id: "t5", name: "bash", arguments: { command: "curl -s https://stripe.internal/webhook-v3-spec" } }] },
			{
				role: "toolResult",
				toolCallId: "t5",
				toolName: "bash",
				content: `{"header":"X-Webhook-Sig-V3","algo":"hmac-sha256","skew_sec":300,"notes":"${"lorem ipsum ".repeat(90)}"}`,
			},
			{ role: "assistant", content: [{ type: "toolCall", id: "t6", name: "bash", arguments: { command: "curl -s https://metrics.internal/healthz-verbose" } }] },
			{
				role: "toolResult",
				toolCallId: "t6",
				toolName: "bash",
				content: Array.from({ length: 80 }, (_, i) => `metric_bucket_${i} 0.00${i}`).join("\n"),
			},
			{ role: "assistant", content: [{ type: "toolCall", id: "t7", name: "edit", arguments: { path: "src/billing/webhook.ts" } }] },
			{ role: "toolResult", toolCallId: "t7", toolName: "edit", content: "Updated src/billing/webhook.ts" },
			{ role: "assistant", content: [{ type: "toolCall", id: "t8", name: "bash", arguments: { command: "node --test test/webhook.test.ts" } }] },
			{
				role: "toolResult",
				toolCallId: "t8",
				toolName: "bash",
				isError: true,
				content: `TAP version 13\n${Array.from({ length: 60 }, (_, i) => `# trace line ${i}`).join("\n")}\nnot ok 2 - rejects expired X-Webhook-Sig-V3 timestamp`,
			},
		],
	};
}

function sessionMonorepoSearchAndBuild() {
	return {
		name: "monorepo-search-build-triage",
		expectGoal: "zero-downtime SQLite WAL checkpoint",
		expectError: "SQLITE_BUSY_SNAPSHOT",
		expectRescued: "wal_autocheckpoint=1000",
		messages: [
			{ role: "user", content: "Fix zero-downtime SQLite WAL checkpoint contention under concurrent readers." },
			{ role: "user", content: "ok" },
			{ role: "assistant", content: [{ type: "toolCall", id: "m1", name: "bash", arguments: { command: "rg -n 'pragma' src/" } }] },
			{
				role: "toolResult",
				toolCallId: "m1",
				toolName: "bash",
				content: Array.from({ length: 120 }, (_, i) => `src/db/mod_${i}.ts:${i}: PRAGMA busy_timeout=5000`).join("\n"),
			},
			{ role: "assistant", content: [{ type: "toolCall", id: "m2", name: "bash", arguments: { command: "cargo build --release" } }] },
			{
				role: "toolResult",
				toolCallId: "m2",
				toolName: "bash",
				content: `${Array.from({ length: 140 }, (_, i) => `   Compiling crate_${i} v0.1.0`).join("\n")}\nFinished release [optimized] target(s) in 18.42s`,
			},
			{ role: "assistant", content: [{ type: "toolCall", id: "m3", name: "bash", arguments: { command: "sqlite3 prod-snap.db 'PRAGMA all;'" } }] },
			{
				role: "toolResult",
				toolCallId: "m3",
				toolName: "bash",
				content: `wal_autocheckpoint=1000\njournal_mode=wal\n${Array.from({ length: 70 }, (_, i) => `setting_${i}=${i}`).join("\n")}`,
			},
			{ role: "assistant", content: [{ type: "toolCall", id: "m4", name: "bash", arguments: { command: "go test ./..." } }] },
			{
				role: "toolResult",
				toolCallId: "m4",
				toolName: "bash",
				isError: true,
				content: "FAIL internal/store\nError: SQLITE_BUSY_SNAPSHOT during PASSIVE checkpoint under 16 workers",
			},
		],
	};
}

function sessionLongReadChurn() {
	return {
		name: "long-file-read-churn",
		expectGoal: "bounded streaming parser",
		expectError: "heap limit exceeded at 28 MB",
		expectRescued: "offset=4096",
		messages: [
			{ role: "user", content: "Refactor the parser into a bounded streaming parser under a 25 MB V8 old-space limit." },
			{ role: "assistant", content: [{ type: "toolCall", id: "r1", name: "read", arguments: { path: "src/parser.ts" } }] },
			{
				role: "toolResult",
				toolCallId: "r1",
				toolName: "read",
				content: Array.from({ length: 400 }, (_, i) => `const token_${i} = buffer.subarray(${i}, ${i + 4});`).join("\n"),
			},
			{ role: "assistant", content: [{ type: "toolCall", id: "r2", name: "read", arguments: { path: "src/tokenizer.ts" } }] },
			{
				role: "toolResult",
				toolCallId: "r2",
				toolName: "read",
				content: Array.from({ length: 350 }, (_, i) => `export function scan${i}(buf: Uint8Array) { return buf[0]; }`).join("\n"),
			},
			{ role: "assistant", content: [{ type: "toolCall", id: "r3", name: "bash", arguments: { command: "node --inspect-brk=0 perf/dump-offsets.mjs" } }] },
			{
				role: "toolResult",
				toolCallId: "r3",
				toolName: "bash",
				content: `frame=seg_42 offset=4096 peak_old_space_mb=22.2\n${"frame_padding=ok\n".repeat(75)}`,
			},
			{ role: "assistant", content: [{ type: "toolCall", id: "r4", name: "bash", arguments: { command: "node --max-old-space-size=25 test/parser.bench.mjs" } }] },
			{
				role: "toolResult",
				toolCallId: "r4",
				toolName: "bash",
				isError: true,
				content: "FATAL ERROR: heap limit exceeded at 28 MB on fixture chunk #19",
			},
		],
	};
}

function runScenario(corpus) {
	const ITERATIONS = 50;
	const t0 = performance.now();
	let rendered;
	for (let i = 0; i < ITERATIONS; i++) {
		const steps = normalizeSteps(corpus.messages);
		const entries = pruneStepsDeterministic(steps);
		const asks = entries.filter((e) => e.verdict === "ask");
		if (asks.length > 0) {
			const answers = {};
			asks.forEach((entry, idx) => {
				const isFirst = idx === 0;
				answers[`result_${entry.step.id}`] = {
					type: "bool",
					probability: isFirst ? 0.91 : 0.12,
				};
				answers[`essential_${entry.step.id}`] = {
					type: "bool",
					probability: isFirst ? 0.89 : 0.14,
				};
			});
			applyJevAnswers(asks, answers);
		}
		resolveRemainingAsks(entries);
		rendered = renderPrunedResult(entries);
	}
	const perRunMs = Number(((performance.now() - t0) / ITERATIONS).toFixed(3));
	const s = rendered.stats;
	return {
		scenario: corpus.name,
		perRunMs,
		steps: s.totalSteps,
		rawChars: s.rawChars,
		prunedChars: s.prunedChars,
		reductionPct: Number((s.reductionRatio * 100).toFixed(1)),
		keptVerbatim: s.keptVerbatim,
		truncated: s.truncated,
		dropped: s.dropped,
		recall: {
			goal: rendered.prunedTranscript.includes(corpus.expectGoal),
			error: rendered.retainedEvidenceBlock.includes(corpus.expectError),
			rescued: rendered.retainedEvidenceBlock.includes(corpus.expectRescued),
		},
	};
}

// 6-pass iterative prompt-growth stability test (verifies carried previousSummary does not decay or bloat exponentially)
function runMultiPassProbe() {
	let summary = "## Objective\nMigrate billing webhook verifier\n## Constraints\n- Never weaken HMAC check\n## Blockers\n- rejects expired X-Webhook-Sig-V3 timestamp";
	const sizes = [];
	for (let pass = 1; pass <= 6; pass++) {
		const r = runScenario(sessionWebhookMigration());
		const prompt = buildHybridSynthesisPrompt({
			prunedTranscript: `[Pass ${pass} pruned signal=${r.prunedChars} chars]`,
			previousSummary: summary,
		});
		sizes.push(prompt.length);
		summary = `${summary}\n- Pass ${pass} verified`;
	}
	return { passes: 6, promptLengths: sizes, boundedGrowth: sizes[5] - sizes[0] < 300 };
}

const results = [
	runScenario(sessionWebhookMigration()),
	runScenario(sessionMonorepoSearchAndBuild()),
	runScenario(sessionLongReadChurn()),
];

const totalRaw = results.reduce((a, r) => a + r.rawChars, 0);
const totalPruned = results.reduce((a, r) => a + r.prunedChars, 0);
const aggregateReductionPct = Number(((1 - totalPruned / totalRaw) * 100).toFixed(1));
const multiPass = runMultiPassProbe();

console.log(
	JSON.stringify(
		{
			scenarios: results,
			aggregate: {
				totalRawChars: totalRaw,
				totalPrunedChars: totalPruned,
				aggregateReductionPct,
				allRecallPassed: results.every((r) => r.recall.goal && r.recall.error && r.recall.rescued),
			},
			multiPass,
		},
		null,
		2,
	),
);
