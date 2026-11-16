/**
 * Sieve Hybrid Compaction (Deterministic + System One Prune + Semantic Cascade Synthesis)
 *
 * Stage 1 uses deterministic observation masking + any available System One classifier
 * (`opencode/jev-1.13-free`, Cloudflare `clef-flash`, OpenRouter Clef/Jev, OpenAI `gpt-6-luna`,
 * Copilot `microsoft-decision-1`, or local llama.cpp `/v1/systemone`) to rescue vital facts.
 * Stage 2 summarizes ONLY the pruned signal transcript via configured compaction cascade.
 */
import { uuidv7 } from "@earendil-works/pi-ai";
import { convertToLlm, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { classifyWithAdapters } from "../src/classifier-adapter.ts";
import {
	applyJevAnswers,
	buildHybridSynthesisPrompt,
	buildJudgeTranscriptState,
	buildJevQuestionsForBatch,
	formatFileOpsXml,
	normalizeSteps,
	pruneStepsDeterministic,
	renderPrunedResult,
	resolveRemainingAsks,
	SYNTHESIS_SYSTEM_PROMPT,
	type CompactMessageLike,
	type JevBoolAnswer,
} from "../src/compaction-core.ts";
import { loadSieveConfig } from "../src/config.ts";
import { COMPACTION_CASCADE, FAST_CASCADE, FREE_CASCADE, selectModelFromCascades } from "../src/router-core.ts";
import { getRuntimeState } from "../src/runtime-state.ts";

const JEV_BATCH_SIZE = 10;
const JEV_MAX_BATCHES = 3;

export default function (pi: ExtensionAPI) {
	const config = loadSieveConfig();

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

		// Stage 1b: Optional System One classification for ambiguous bulk tool outputs.
		const askEntries = entries.filter((e) => e.verdict === "ask");
		const runtimeState = getRuntimeState();
		let jevRequests = 0;
		let jevAnswered = 0;
		let usedClassifier = "rules-only";

		if (askEntries.length > 0 && !signal.aborted) {
			const judgeState = buildJudgeTranscriptState(entries);
			for (let i = 0; i < askEntries.length && jevRequests < JEV_MAX_BATCHES; i += JEV_BATCH_SIZE) {
				if (signal.aborted) break;
				const batch = askEntries.slice(i, i + JEV_BATCH_SIZE);
				const adaptive = await classifyWithAdapters(
					ctx,
					{
						state: { transcript: judgeState },
						questions: buildJevQuestionsForBatch(batch),
					},
					{
						preferred: runtimeState.preferredClassifier,
						systemOne: config.systemOne,
						timeoutMs: 3000,
						signal,
					},
				);
				jevRequests += 1;
				if (adaptive) {
					usedClassifier = adaptive.usedClassifier;
					jevAnswered += applyJevAnswers(batch, adaptive.result.answers as Record<string, JevBoolAnswer | undefined>);
				}
			}
		}

		resolveRemainingAsks(entries);
		const pruned = renderPrunedResult(entries);
		if (!pruned.prunedTranscript.trim()) return;

		// Stage 2: Semantic synthesis over the pruned signal transcript.
		const avail = ctx.modelRegistry.getAvailable();
		const now = Date.now();
		const isCooling = (provider: string) => (runtimeState.providerCooldownUntil.get(provider) ?? 0) > now;
		const compList = config.cascades?.compaction ?? COMPACTION_CASCADE;
		const fastList = config.cascades?.fast ?? FAST_CASCADE;
		const freeList = config.cascades?.free ?? FREE_CASCADE;

		const prompt = buildHybridSynthesisPrompt({
			prunedTranscript: pruned.prunedTranscript,
			previousSummary: preparation.previousSummary,
			customInstructions,
		});

		let synthesized = "";
		let usedModel = "";
		let usage: unknown;
		const tried = new Set<string>();

		for (let attempt = 0; attempt < 4; attempt++) {
			if (signal.aborted) return;
			const candidate = selectModelFromCascades(avail, [compList, fastList, freeList], {
				preferReasoning: false,
				isCoolingDown: (p, id) => isCooling(p) || tried.has(`${p}/${id}`),
			});
			if (!candidate) break;
			const key = `${candidate.provider}/${candidate.id}`;
			if (tried.has(key)) break;
			tried.add(key);

			try {
				const res = await ctx.modelRegistry.complete(
					candidate,
					{
						systemPrompt: SYNTHESIS_SYSTEM_PROMPT,
						messages: [{ role: "user", content: [{ type: "text", text: prompt }], timestamp: Date.now() }],
					},
					{ maxTokens: 4096, signal, cacheRetention: "none", sessionId: uuidv7() },
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
					usedModel = key;
					usage = res.usage;
					break;
				}
			} catch {
				// Try next cascade model.
			}
		}

		if (!synthesized) return;

		// Stage 3: Append deterministic Retained Evidence + fileOps XML.
		const fileOpsBlock = formatFileOpsXml(preparation.fileOps);
		const evidenceSection = pruned.retainedEvidenceBlock
			? `\n\n## Retained Tool Evidence (Verbatim)\n${pruned.retainedEvidenceBlock}`
			: "";
		const summary = `${synthesized}${evidenceSection}${fileOpsBlock}`;

		const elapsedMs = Date.now() - started;
		const prunePct = Math.round(pruned.stats.reductionRatio * 100);
		runtimeState.lastCompaction = {
			steps: pruned.stats.totalSteps,
			prunePct,
			jevAnswered,
			usedModel,
			elapsedMs,
		};

		ctx.ui?.notify?.(
			`Hybrid compact: pre-pruned ${prunePct}% (${pruned.stats.totalSteps} steps, ${usedClassifier}=${jevAnswered}) -> ${usedModel} in ${elapsedMs}ms`,
			"info",
		);

		return {
			compaction: {
				summary,
				firstKeptEntryId: preparation.firstKeptEntryId,
				tokensBefore: preparation.tokensBefore,
				...(usage ? { usage: usage as never } : {}),
				details: {
					source: "sieve-hybrid-compaction",
					classifier: usedClassifier,
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
