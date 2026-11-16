import assert from "node:assert/strict";
import test from "node:test";
import {
	applyJevAnswers,
	buildJevQuestionsForBatch,
	formatFileOpsXml,
	normalizeSteps,
	pruneStepsDeterministic,
	renderPrunedResult,
	resolveRemainingAsks,
} from "../src/compaction-core.ts";

test("normalizeSteps pairs toolCall arguments with toolResult and strips hindsight blocks", () => {
	const messages = [
		{ role: "user", content: "Check the failing migration script" },
		{
			role: "user",
			customType: "hindsight",
			display: false,
			content: "<hindsight_memory>injected</hindsight_memory>",
		},
		{
			role: "assistant",
			content: [
				{ type: "text", text: "Running vitest now." },
				{ type: "toolCall", id: "call_1", name: "bash", arguments: { command: "npx vitest run" } },
			],
		},
		{
			role: "toolResult",
			toolCallId: "call_1",
			toolName: "bash",
			isError: true,
			content: "FAIL src/db.test.ts\nAssertionError: expected 200 to equal 500",
		},
	];

	const steps = normalizeSteps(messages);
	assert.equal(steps.length, 3);
	assert.equal(steps[0].kind, "user");
	assert.equal(steps[1].kind, "assistant");
	assert.equal(steps[2].kind, "tool");
	assert.equal(steps[2].error, true);
	assert.match(steps[2].callLine ?? "", /npx vitest run/);
});

test("deterministic + Jev hybrid retains errors, user constraints, and Jev-rescued non-pinned outputs", () => {
	const messages = [
		{ role: "user", content: "Never drop the API token schema check in middleware." },
		{ role: "user", content: "ok" }, // acknowledgement -> dropped
		{
			role: "assistant",
			content: [{ type: "toolCall", id: "c1", name: "read", arguments: { path: "src/big.ts" } }],
		},
		{
			role: "toolResult",
			toolCallId: "c1",
			toolName: "read",
			content: "export const line = 1;\n".repeat(400), // >2500 chars re-readable file read -> masked
		},
		{
			role: "assistant",
			content: [{ type: "toolCall", id: "c2", name: "bash", arguments: { command: "curl https://staging.internal/schema" } }],
		},
		{
			role: "toolResult",
			toolCallId: "c2",
			toolName: "bash",
			content: `{"token_field":"x_sieve_sig","ttl_sec":300,"padding":"${"z".repeat(900)}"}`,
		},
		{
			role: "assistant",
			content: [{ type: "toolCall", id: "c3", name: "bash", arguments: { command: "npm test" } }],
		},
		{
			role: "toolResult",
			toolCallId: "c3",
			toolName: "bash",
			isError: true,
			content: "Error: token_field assertion failed on /v1/verify",
		},
	];

	const steps = normalizeSteps(messages);
	const entries = pruneStepsDeterministic(steps);
	const asks = entries.filter((e) => e.verdict === "ask");
	assert.equal(asks.length, 1);

	const q = buildJevQuestionsForBatch(asks);
	assert.ok(q[`result_${asks[0].step.id}`]);
	assert.ok(q[`essential_${asks[0].step.id}`]);

	const answered = applyJevAnswers(asks, {
		[`result_${asks[0].step.id}`]: { type: "bool", probability: 0.91 },
		[`essential_${asks[0].step.id}`]: { type: "bool", probability: 0.88 },
	});
	assert.equal(answered, 1);

	resolveRemainingAsks(entries);
	const rendered = renderPrunedResult(entries);

	assert.match(rendered.prunedTranscript, /Never drop the API token schema check/);
	assert.match(rendered.prunedTranscript, /file re-readable/);
	assert.match(rendered.retainedEvidenceBlock, /x_sieve_sig/);
	assert.match(rendered.retainedEvidenceBlock, /token_field assertion failed/);
	assert.ok(rendered.stats.reductionRatio > 0.5);
});

test("formatFileOpsXml separates read-only files from modified files deterministically", () => {
	const xml = formatFileOpsXml({
		read: new Set(["src/b.ts", "src/a.ts"]),
		written: new Set(["src/new.ts"]),
		edited: new Set(["src/b.ts"]),
	});
	assert.match(xml, /<read-files>\nsrc\/a\.ts\n<\/read-files>/);
	assert.match(xml, /<modified-files>\nsrc\/b\.ts\nsrc\/new\.ts\n<\/modified-files>/);
});
