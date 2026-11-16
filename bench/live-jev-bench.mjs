/**
 * Live System One (`opencode/jev-1.13-free`) evaluation harness.
 * Exercises real HTTP classification calls via Pi's credential + ModelRuntime
 * on both compaction evidence probes and semantic routing prompts.
 */
import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import {
	createAgentSession,
	ModelRegistry,
	SessionManager,
} from "/home/noorm/.local/lib/node_modules/@earendil-works/pi-coding-agent/dist/index.js";
import { mapJevAnswers } from "../src/router-core.ts";

const { session } = await createAgentSession({
	sessionManager: SessionManager.inMemory(),
});

const modelRegistry = new ModelRegistry(session._modelRuntime);
const jev = modelRegistry.findOfType("classifier", "opencode", "jev-1.13-free");
if (!jev) {
	console.error("opencode/jev-1.13-free classifier model not configured in Pi auth/registry");
	process.exit(1);
}

const routingProbes = [
	{
		label: "trivial-chat",
		prompt: "What does HTTP 304 Not Modified mean in one sentence?",
		expectedTiers: ["low", "medium"],
	},
	{
		label: "bounded-implement",
		prompt: "Write a TypeScript helper that retries a fetch call up to 3 times with exponential backoff.",
		expectedTiers: ["medium", "high"],
	},
	{
		label: "architectural-concurrency",
		prompt: "Architect a zero-downtime distributed lock service with fencing tokens and split-brain mitigation across multi-region Postgres.",
		expectedTiers: ["high", "xhigh"],
	},
];

const routingResults = [];
for (const probe of routingProbes) {
	const t0 = performance.now();
	const res = await modelRegistry.classify(
		jev,
		{
			state: { prompt: probe.prompt },
			questions: {
				task_kind: {
					type: "choice",
					instructions: "What primary kind of work is requested in `prompt`?",
					criteria: {
						chat: "Quick greeting, acknowledgement, or trivial question",
						explain: "Explaining code, concepts, or reading output",
						implement: "Writing features, tests, scripts, or bounded bug fixes",
						research: "Investigating docs, papers, or external systems",
						debug: "Root-cause diagnosis of failures, concurrency, or subtle bugs",
						plan: "Architecture, cross-cutting refactors, specs, or security review",
					},
				},
				complexity: {
					type: "choice",
					instructions: "How demanding is the software engineering task in `prompt`?",
					criteria: {
						trivial: "Single-step lookup, simple formatting, or one-line edit",
						standard: "Ordinary bounded feature, fix, test, or research",
						complex: "Multi-file design, subtle debugging, or non-trivial trade-offs",
						architectural: "System-wide architecture, concurrency/security, or deep root-cause bug",
					},
				},
				deep_reasoning: {
					type: "bool",
					instructions: "Does this prompt genuinely benefit from extended multi-step reasoning?",
					criteria: {
						true: "Requires planning, security/concurrency analysis, or hard debugging",
						false: "Straightforward execution or lookup",
					},
				},
			},
		},
		{ signal: AbortSignal.timeout(8000) },
	);
	const ms = Math.round(performance.now() - t0);
	const kind = res.answers.task_kind?.type === "choice" ? res.answers.task_kind.choice : "implement";
	const complexity = res.answers.complexity?.type === "choice" ? res.answers.complexity.choice : "standard";
	const deep = res.answers.deep_reasoning?.type === "bool" ? res.answers.deep_reasoning.probability >= 0.55 : false;
	const mapped = mapJevAnswers(kind, complexity, deep, "low");
	routingResults.push({
		label: probe.label,
		latencyMs: ms,
		costUsd: res.usage?.cost?.total ?? 0,
		kind,
		complexity,
		deepReasoning: deep,
		thinking: mapped.thinking,
		matchedExpected: probe.expectedTiers.includes(mapped.thinking),
	});
}

const compactionTranscript = `[user 1] Migrate billing webhooks to HMAC-SHA256.
[tool 2] bash(curl -s https://stripe.internal/webhook-v3-spec) -> {"header":"X-Webhook-Sig-V3","algo":"hmac-sha256","skew_sec":300}
[tool 3] bash(curl -s https://metrics.internal/healthz) -> metric_ok=1 uptime=99.98% workers=4`;

const t1 = performance.now();
const compRes = await modelRegistry.classify(
	jev,
	{
		state: { transcript: compactionTranscript },
		questions: {
			result_2: {
				type: "bool",
				instructions: "Does tool step 2 (curl webhook-v3-spec) contain essential non-reproducible facts, IDs, or schemas needed verbatim?",
				criteria: { true: "Needed verbatim to resume work accurately", false: "Routine status noise" },
			},
			result_3: {
				type: "bool",
				instructions: "Does tool step 3 (curl healthz metrics) contain essential non-reproducible facts needed verbatim for coding?",
				criteria: { true: "Needed verbatim to resume work accurately", false: "Routine status noise" },
			},
		},
	},
	{ signal: AbortSignal.timeout(8000) },
);
const compMs = Math.round(performance.now() - t1);

const output = {
	classifier: "opencode/jev-1.13-free",
	routingProbes: routingResults,
	compactionProbe: {
		latencyMs: compMs,
		costUsd: compRes.usage?.cost?.total ?? 0,
		step2SchemaKeep: compRes.answers.result_2,
		step3HealthNoiseKeep: compRes.answers.result_3,
	},
};

fs.mkdirSync(path.resolve("bench/results"), { recursive: true });
fs.writeFileSync(path.resolve("bench/results/latest-live.json"), JSON.stringify(output, null, 2));
console.log(JSON.stringify(output, null, 2));
await session.dispose?.();
