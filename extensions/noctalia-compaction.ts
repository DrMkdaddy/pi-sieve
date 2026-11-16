/**
 * Noctalia Hybrid Compaction (Deterministic + Jev-1.13 Prune + Semantic Cascade Synthesis)
 *
 * Combines two complementary strengths at the compaction boundary (`session_before_compact`):
 * 1. Stage 1 (Observation Masking + $0 Jev Filter): Strips repetitive/noisy tool outputs
 *    while asking `opencode/jev-1.13-free` whether ambiguous bulk steps hold non-reproducible
 *    evidence (`keep-verbatim`) or noise (`drop`).
 * 2. Stage 2 (Semantic Synthesis): Summarizes ONLY the high-signal pruned transcript on
 *    `COMPACTION_CASCADE` with `cacheRetention: "none"`, preserving design rationale ("why")
 *    plus deterministic `Retained Tool Evidence` and `<read-files>` / `<modified-files>`.
 */
import { uuidv7 } from "@earendil-works/pi-ai";
import {
	computeFileLists,
	convertToLlm,
	formatFileOperations,
	SUMMARIZATION_SYSTEM_PROMPT,
	type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import {
	applyJevAnswers,
	buildHybridSynthesisPrompt,
	buildJudgeTranscriptState,
	buildJevQuestionsForBatch,
	normalizeSteps,
	pruneStepsDeterministic,
	renderPrunedResult,
	resolveRemainingAsks,
	type CompactMessageLike,
	type JevBoolAnswer,
} from "../src/compaction-core.ts";
import { COMPACTION_CASCADE, FAST_CASCADE, FREE_CASCADE } from "../src/router-core.ts";

const JEV_BATCH_SIZE = 10;
const JEV_MAX_BATCHES = 3;

export default function (pi: ExtensionAPI) {
	pi.on("session_before_compact", async (event, ctx) => {
		const { preparation, customInstructions, signal } = event;
		const allMessages = [...preparation.messagesToSummarize, ...preparation.turnPrefixMessages];
		if (allMessages.length === 0) return;

		const started = Date.now();
		const llmMessages = convertToLlm(allMessages) as unknown as CompactMessageLike[];
		const steps = normalizeSteps(llmMessages);
		if (steps.length === 0) return;

		// Stage 1a: Deterministic observation masking.
		const entries = pruneStepsDeterministic(steps);

		// Stage 1b: Optional $0 Jev classification for ambiguous bulk tool outputs.
		const askEntries = entries.filter((e) => e.verdict === "ask");
		let jevRequests = 0;
		let jevAnswered = 0;

		if (askEntries.length > 0 && !signal.aborted) {
			const jev =
				ctx.modelRegistry.findOfType("classifier", "opencode", "jev-1.13-free") ??
				ctx.modelRegistry.findOfType("classifier", "typesafe", "jev-latest");
			if (jev) {
				const judgeState = buildJudgeTranscriptState(entries);
				for (let i = 0; i < askEntries.length && jevRequests < JEV_MAX_BATCHES; i += JEV_BATCH_SIZE) {
					if (signal.aborted) break;
					const batch = askEntries.slice(i, i + JEV_BATCH_SIZE);
					try {
						const timeout = AbortSignal.timeout(3000);
						const combined = AbortSignal.any([signal, timeout]);
						const res = await ctx.modelRegistry.classify(
							jev,
							{
								state: { transcript: judgeState },
								questions: buildJevQuestionsForBatch(batch),
							},
							{ signal: combined },
						);
						jevRequests += 1;
						if (res.stopReason === "stop") {
							jevAnswered += applyJevAnswers(batch, res.answers as Record<string, JevBoolAnswer | undefined>);
						}
					} catch {
						// Best-effort classifier; deterministic fallback handles remaining steps.
					}
				}
			}
		}

		resolveRemainingAsks(entries);
		const pruned = renderPrunedResult(entries);
		if (!pruned.prunedTranscript.trim()) return;

		// Stage 2: Semantic synthesis over the pruned signal transcript via COMPACTION_CASCADE.
		const avail = ctx.modelRegistry.getAvailable();
		const routerState = (globalThis as Record<string, unknown>).__noctaliaRouterState as
			| { providerCooldownUntil?: Map<string, number> }
			| undefined;
		const now = Date.now();
		const isCooling = (provider: string) => (routerState?.providerCooldownUntil?.get(provider) ?? 0) > now;

		const orderedCandidates = [...COMPACTION_CASCADE, ...FAST_CASCADE, ...FREE_CASCADE];
		const seenModels = new Set<string>();
		const summaryModels = [];
		for (const c of orderedCandidates) {
			const key = `${c.provider}/${c.id}`;
			if (seenModels.has(key) || isCooling(c.provider)) continue;
			seenModels.add(key);
			const found = avail.find((m) => m.provider === c.provider && m.id === c.id);
			if (found) summaryModels.push(found);
		}
		if (summaryModels.length === 0 && ctx.model && ctx.model.provider !== "router") {
			summaryModels.push(ctx.model);
		}
		if (summaryModels.length === 0) return;

		const prompt = buildHybridSynthesisPrompt({
			prunedTranscript: pruned.prunedTranscript,
			previousSummary: preparation.previousSummary,
			customInstructions,
		});

		let synthesized = "";
		let usedModel = "";
		let usage: unknown;

		for (const model of summaryModels) {
			if (signal.aborted) return;
			try {
				const res = await ctx.modelRegistry.complete(
					model,
					{
						systemPrompt: SUMMARIZATION_SYSTEM_PROMPT,
						messages: [{ role: "user", content: [{ type: "text", text: prompt }], timestamp: Date.now() }],
					},
					{
						maxTokens: 4096,
						signal,
						cacheRetention: "none",
						sessionId: uuidv7(),
					},
				);
				if (res.stopReason === "aborted") return;
				if (res.stopReason === "error") continue;
				const text = res.content
					.filter((b): b is { type: "text"; text: string } => b.type === "text")
					.map((b) => b.text)
					.join("\n")
					.trim();
				if (text) {
					synthesized = text;
					usedModel = `${model.provider}/${model.id}`;
					usage = res.usage;
					break;
				}
			} catch {
				// Try next candidate in cascade.
			}
		}

		if (!synthesized) return;

		// Stage 3: Append deterministic Retained Evidence (Jev keeps & errors) + Pi fileOps XML.
		const { readFiles, modifiedFiles } = computeFileLists(preparation.fileOps);
		const fileOpsBlock = formatFileOperations(readFiles, modifiedFiles);
		const evidenceSection = pruned.retainedEvidenceBlock
			? `\n\n## Retained Tool Evidence (Verbatim)\n${pruned.retainedEvidenceBlock}`
			: "";
		const summary = `${synthesized}${evidenceSection}${fileOpsBlock}`;

		const elapsedMs = Date.now() - started;
		const prunePct = Math.round(pruned.stats.reductionRatio * 100);
		(globalThis as Record<string, unknown>).__noctaliaCompactionStats = {
			steps: pruned.stats.totalSteps,
			prunePct,
			jevAnswered,
			usedModel,
			elapsedMs,
		};

		ctx.ui?.notify?.(
			`Hybrid compact: pre-pruned ${prunePct}% (${pruned.stats.totalSteps} steps, Jev=${jevAnswered}) -> ${usedModel} in ${elapsedMs}ms`,
			"info",
		);

		return {
			compaction: {
				summary,
				firstKeptEntryId: preparation.firstKeptEntryId,
				tokensBefore: preparation.tokensBefore,
				...(usage ? { usage: usage as never } : {}),
				details: {
					source: "noctalia-hybrid-compaction",
					prePruneStats: pruned.stats,
					jevRequests,
					jevAnswered,
					summaryModel: usedModel,
					elapsedMs,
				},
			},
		};
	});
}
