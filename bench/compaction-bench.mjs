/**
 * Reproducible compaction pre-filter benchmark.
 * Evaluates observation masking + simulated Jev rescue on realistic agent transcripts
 * containing install noise, large re-readable reads, grep dumps, duplicate calls,
 * failing test errors, edits, and non-reproducible API payloads.
 */
import { performance } from "node:perf_hooks";
import {
	applyJevAnswers,
	normalizeSteps,
	pruneStepsDeterministic,
	renderPrunedResult,
	resolveRemainingAsks,
} from "../src/compaction-core.ts";

function makeTranscript() {
	return [
		{ role: "user", content: "Migrate the billing webhook verifier to constant-time HMAC and keep retry idempotency intact." },
		{
			role: "assistant",
			content: [
				{ type: "text", text: "Installing dependencies and inspecting the repository layout." },
				{ type: "toolCall", id: "t1", name: "bash", arguments: { command: "npm install" } },
			],
		},
		{
			role: "toolResult",
			toolCallId: "t1",
			toolName: "bash",
			content: `${Array.from({ length: 160 }, (_, i) => `added pkg-${i}@1.2.${i} in 12ms`).join("\n")}\nadded 160 packages in 2.4s\nfound 0 vulnerabilities`,
		},
		{
			role: "assistant",
			content: [{ type: "toolCall", id: "t2", name: "grep", arguments: { pattern: "verifyWebhook" } }],
		},
		{
			role: "toolResult",
			toolCallId: "t2",
			toolName: "bash",
			content: Array.from({ length: 95 }, (_, i) => `src/routes/r${i}.ts:${i + 1}: verifyWebhook(req)`).join("\n"),
		},
		{
			role: "assistant",
			content: [{ type: "toolCall", id: "t3", name: "read", arguments: { path: "src/billing/webhook.ts" } }],
		},
		{
			role: "toolResult",
			toolCallId: "t3",
			toolName: "read",
			content: Array.from({ length: 240 }, (_, i) => `export function line${i}() { return ${i}; }`).join("\n"),
		},
		// Duplicate read that should collapse completely
		{
			role: "assistant",
			content: [{ type: "toolCall", id: "t4", name: "read", arguments: { path: "src/billing/webhook.ts" } }],
		},
		{
			role: "toolResult",
			toolCallId: "t4",
			toolName: "read",
			content: Array.from({ length: 240 }, (_, i) => `export function line${i}() { return ${i}; }`).join("\n"),
		},
		// Non-reproducible remote schema lookup (Jev rescues)
		{
			role: "assistant",
			content: [{ type: "toolCall", id: "t5", name: "bash", arguments: { command: "curl -s https://stripe.internal/webhook-v3-spec" } }],
		},
		{
			role: "toolResult",
			toolCallId: "t5",
			toolName: "bash",
			content: `{"header":"X-Webhook-Sig-V3","algo":"hmac-sha256","skew_sec":300,"notes":"${"lorem ipsum ".repeat(90)}"}`,
		},
		// Noisy background curl metrics (Jev drops)
		{
			role: "assistant",
			content: [{ type: "toolCall", id: "t6", name: "bash", arguments: { command: "curl -s https://metrics.internal/healthz-verbose" } }],
		},
		{
			role: "toolResult",
			toolCallId: "t6",
			toolName: "bash",
			content: Array.from({ length: 80 }, (_, i) => `metric_bucket_${i} 0.00${i}`).join("\n"),
		},
		// Edit mutation + failing test run
		{
			role: "assistant",
			content: [{ type: "toolCall", id: "t7", name: "edit", arguments: { path: "src/billing/webhook.ts", oldText: "a", newText: "b" } }],
		},
		{ role: "toolResult", toolCallId: "t7", toolName: "edit", content: "Updated src/billing/webhook.ts" },
		{
			role: "assistant",
			content: [{ type: "toolCall", id: "t8", name: "bash", arguments: { command: "node --test test/webhook.test.ts" } }],
		},
		{
			role: "toolResult",
			toolCallId: "t8",
			toolName: "bash",
			isError: true,
			content: `TAP version 13\n${Array.from({ length: 60 }, (_, i) => `# trace line ${i}`).join("\n")}\nnot ok 2 - rejects expired X-Webhook-Sig-V3 timestamp`,
		},
	];
}

const transcript = makeTranscript();
const ITERATIONS = 100;
const t0 = performance.now();

let lastResult;
for (let i = 0; i < ITERATIONS; i++) {
	const steps = normalizeSteps(transcript);
	const entries = pruneStepsDeterministic(steps);
	const asks = entries.filter((e) => e.verdict === "ask");
	if (asks.length >= 2) {
		applyJevAnswers(asks, {
			[`result_${asks[0].step.id}`]: { type: "bool", choice: true, probabilities: { true: 0.92, false: 0.08 } },
			[`essential_${asks[0].step.id}`]: { type: "bool", choice: true, probabilities: { true: 0.89, false: 0.11 } },
			[`result_${asks[1].step.id}`]: { type: "bool", choice: false, probabilities: { true: 0.12, false: 0.88 } },
			[`essential_${asks[1].step.id}`]: { type: "bool", choice: false, probabilities: { true: 0.15, false: 0.85 } },
		});
	}
	resolveRemainingAsks(entries);
	lastResult = renderPrunedResult(entries);
}

const totalMs = performance.now() - t0;
const perRunMs = totalMs / ITERATIONS;
const s = lastResult.stats;
const rawTokensEst = Math.ceil(s.rawChars / 4);
const prunedTokensEst = Math.ceil(s.prunedChars / 4);
const retainedGoal = lastResult.prunedTranscript.includes("constant-time HMAC");
const retainedError = lastResult.retainedEvidenceBlock.includes("rejects expired X-Webhook-Sig-V3 timestamp");
const retainedJevKeep = lastResult.retainedEvidenceBlock.includes("X-Webhook-Sig-V3");

console.log(
	JSON.stringify(
		{
			iterations: ITERATIONS,
			perRunMs: Number(perRunMs.toFixed(3)),
			totalSteps: s.totalSteps,
			rawChars: s.rawChars,
			prunedChars: s.prunedChars,
			rawTokensEst,
			prunedTokensEst,
			reductionPct: Number((s.reductionRatio * 100).toFixed(1)),
			keptVerbatim: s.keptVerbatim,
			truncated: s.truncated,
			dropped: s.dropped,
			recall: {
				userGoal: retainedGoal,
				failingError: retainedError,
				jevRescuedPayload: retainedJevKeep,
			},
		},
		null,
		2,
	),
);
