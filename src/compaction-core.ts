import { extractText, stripInjectedBlocks } from "./router-core.ts";

export interface NormalizedStep {
	id: number;
	kind: "user" | "assistant" | "tool";
	text: string;
	chars: number;
	tool?: string;
	callLine?: string;
	result?: string;
	error?: boolean;
}

export type PruneVerdict = "keep" | "keep-verbatim" | "truncate" | "drop" | "ask";

export interface PrunedEntry {
	step: NormalizedStep;
	verdict: PruneVerdict;
	reason: string;
	rendered?: string;
	judgeScores?: { call: boolean; result: boolean; essential: boolean; resultProb: number };
}

export interface CompactMessageLike {
	role: string;
	content:
		| string
		| ReadonlyArray<{ type: string; text?: string; id?: string; name?: string; arguments?: Record<string, unknown> }>;
	toolCallId?: string;
	toolName?: string;
	isError?: boolean;
	customType?: string;
	display?: boolean;
}

export interface JevBoolAnswer {
	type: "bool";
	choice: boolean;
	confidence?: number;
	probabilities?: { true?: number; false?: number };
}

const ACK_RE =
	/^(ok(ay)?|k|thanks?|thank you|ty|yes|yep|yeah|yup|no|nope|nah|sure|cool|nice|great|perfect|awesome|got it|understood|sounds good|continue|go ahead|proceed|next)\b[\s.!]*$/i;
const MUTATING_RE = /(edit|write|patch|create|delete|move|rename|replace|apply|mkdir|touch|\brm\b|\bmv\b|\bgit\s+commit\b)/i;
const TESTING_RE =
	/\b(pytest|jest|vitest|mocha|rspec|phpunit|unittest|node\s+--test|cargo\s+test|go\s+test|(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?test(?::\w+)?)\b/i;
const BUILDING_RE = /\b(build|compile|tsc|typecheck|lint|make|cargo\s+build|vite\s+build|webpack|ruff|clippy)\b/i;
const INSTALLING_RE =
	/\b(npm\s+(i|install|ci|add)|pnpm\s+(i|add|install)|yarn\s+(add|install)|bun\s+(add|install)|pip\s+install|uv\s+(add|pip|sync)|cargo\s+add)\b/i;
const SEARCHING_RE = /\b(grep|glob|find|rg|ripgrep|search|ls|fd|tree|find_by_name|grep_search)\b/i;
const READING_RE = /\b(read|view|cat|head|tail|less)\b/i;
const GIT_RE = /\bgit\s+(status|diff|log|branch|show)\b/i;

const SUMMARISE_LINE_RE =
	/^\s*(tests?|test suites?|passing|failed|failing|pending|skipped|added|removed|changed|updated|success|done|finished|total)\b|\b\d+\s+(tests?|suites?|files?|packages?|errors?|warnings?|pass|fail)|\b(error|failed|fatal|exception|panic|assert|expected|received|traceback)\b/i;

export function clipMiddle(text: string, limit: number): string {
	const value = text.trimEnd();
	if (value.length <= limit) return value;
	const head = Math.floor(limit * 0.6);
	const tail = limit - head;
	return `${value.slice(0, head)}\n... [${value.length - head - tail} chars masked] ...\n${value.slice(-tail)}`;
}

export function informativeLines(text: string, maxLines = 20): string[] {
	const lines = text.split("\n");
	const picked: string[] = [];
	const seen = new Set<string>();
	for (let i = 0; i < lines.length; i++) {
		const trimmed = lines[i].trim();
		if (!trimmed) continue;
		if (SUMMARISE_LINE_RE.test(trimmed)) {
			for (let j = i; j < Math.min(lines.length, i + 3); j++) {
				const win = lines[j].trim();
				if (win && !seen.has(win)) {
					seen.add(win);
					picked.push(win);
					if (picked.length >= maxLines) return picked;
				}
			}
		}
	}
	return picked;
}

function formatArgsBrief(args: Record<string, unknown> | undefined): string {
	if (!args || typeof args !== "object") return "";
	return Object.entries(args)
		.map(([k, v]) => `${k}=${typeof v === "string" ? clipMiddle(v, 100) : JSON.stringify(v)}`)
		.join(", ");
}

/** Flatten Pi LLM messages into ordered steps pairing tool calls with tool results. */
export function normalizeSteps(messages: readonly CompactMessageLike[]): NormalizedStep[] {
	const steps: NormalizedStep[] = [];
	const pendingCalls = new Map<string, { name: string; callLine: string }>();
	let nextId = 1;

	for (const msg of messages) {
		if (msg.customType || msg.display === false) continue;

		if (msg.role === "user") {
			const text = stripInjectedBlocks(extractText(msg.content));
			if (!text) continue;
			steps.push({ id: nextId++, kind: "user", text, chars: text.length });
			continue;
		}

		if (msg.role === "assistant") {
			if (Array.isArray(msg.content)) {
				for (const block of msg.content) {
					if (block.type === "toolCall" && block.id && block.name) {
						pendingCalls.set(block.id, {
							name: block.name,
							callLine: formatArgsBrief(block.arguments),
						});
					}
				}
			}
			const text = extractText(msg.content).trim();
			if (text) {
				steps.push({ id: nextId++, kind: "assistant", text, chars: text.length });
			}
			continue;
		}

		if (msg.role === "toolResult") {
			const result = extractText(msg.content).trim();
			const call = msg.toolCallId ? pendingCalls.get(msg.toolCallId) : undefined;
			const tool = call?.name ?? msg.toolName ?? "tool";
			const callLine = call?.callLine ?? "";
			const fullText = `${tool}(${callLine})\n${result}`;
			steps.push({
				id: nextId++,
				kind: "tool",
				tool,
				callLine,
				result,
				text: fullText,
				chars: fullText.length,
				error: Boolean(msg.isError),
			});
		}
	}
	return steps;
}

export function classifyToolKind(tool: string, callLine: string): string {
	const hay = `${tool} ${callLine}`;
	if (MUTATING_RE.test(hay) && !SEARCHING_RE.test(hay)) return "mutate";
	if (INSTALLING_RE.test(hay)) return "install";
	if (TESTING_RE.test(hay)) return "test";
	if (BUILDING_RE.test(hay)) return "build";
	if (SEARCHING_RE.test(hay)) return "search";
	if (GIT_RE.test(hay)) return "git";
	if (READING_RE.test(hay)) return "read";
	return "other";
}

/** Stage 1a: Deterministic observation masking before optional Jev classification. */
export function pruneStepsDeterministic(steps: readonly NormalizedStep[]): PrunedEntry[] {
	const seen = new Set<string>();
	const out: PrunedEntry[] = [];

	for (const step of steps) {
		if (step.kind === "user") {
			if (ACK_RE.test(step.text.trim())) {
				out.push({ step, verdict: "drop", reason: "acknowledgement" });
			} else {
				out.push({ step, verdict: "keep", reason: "user instruction", rendered: clipMiddle(step.text, 2400) });
			}
			continue;
		}

		if (step.kind === "assistant") {
			out.push({ step, verdict: "keep", reason: "assistant prose", rendered: clipMiddle(step.text, 3200) });
			continue;
		}

		const tool = step.tool ?? "tool";
		const callLine = step.callLine ?? "";
		const result = step.result ?? "";

		if (step.error) {
			out.push({
				step,
				verdict: "keep-verbatim",
				reason: "tool error",
				rendered: `${tool}(${callLine}) [ERROR]:\n${clipMiddle(result, 2000)}`,
			});
			continue;
		}

		const sig = `${tool}|${callLine}|${result.length}|${result.slice(0, 160)}`;
		if (seen.has(sig)) {
			out.push({ step, verdict: "drop", reason: "duplicate step", rendered: `${tool}(${callLine}) -> [duplicate masked]` });
			continue;
		}
		seen.add(sig);

		const kind = classifyToolKind(tool, callLine);

		if (kind === "mutate") {
			out.push({
				step,
				verdict: "keep",
				reason: "state mutation",
				rendered: `${tool}(${callLine}) -> ${clipMiddle(result || "ok", 400)}`,
			});
			continue;
		}

		if (result.length <= 280) {
			out.push({ step, verdict: "keep", reason: "short output", rendered: `${tool}(${callLine}) -> ${result}` });
			continue;
		}

		if (kind === "install" || kind === "test" || kind === "build" || kind === "git") {
			const picked = informativeLines(result, kind === "install" ? 6 : 16);
			const summary = picked.length ? picked.join("\n") : clipMiddle(result, 400);
			out.push({
				step,
				verdict: "truncate",
				reason: `${kind} output`,
				rendered: `${tool}(${callLine}) [masked ${result.length} -> ${summary.length} chars]:\n${clipMiddle(summary, 900)}`,
			});
			continue;
		}

		if (kind === "search") {
			const lines = result.split("\n").filter((l) => l.trim());
			if (lines.length > 14) {
				out.push({
					step,
					verdict: "drop",
					reason: `${lines.length}-line search listing`,
					rendered: `${tool}(${callLine}) -> [${lines.length} matching lines masked]`,
				});
			} else {
				out.push({
					step,
					verdict: "truncate",
					reason: "short search listing",
					rendered: `${tool}(${callLine}) ->\n${clipMiddle(result, 700)}`,
				});
			}
			continue;
		}

		if (kind === "read" && result.length > 2500) {
			out.push({
				step,
				verdict: "truncate",
				reason: "re-readable file read",
				rendered: `${tool}(${callLine}) [masked ${result.length} chars, file re-readable]`,
			});
			continue;
		}

		if (result.length > 800) {
			out.push({ step, verdict: "ask", reason: "ambiguous bulk output" });
			continue;
		}

		out.push({
			step,
			verdict: "keep",
			reason: "bounded result",
			rendered: `${tool}(${callLine}) -> ${clipMiddle(result, 800)}`,
		});
	}

	return out;
}

export function buildJudgeTranscriptState(entries: readonly PrunedEntry[], maxChars = 48_000): string {
	const lines: string[] = [];
	let spent = 0;
	for (const entry of entries) {
		const s = entry.step;
		const line =
			s.kind === "tool"
				? `[tool ${s.id}] ${s.tool}(${s.callLine ?? ""}) -> ${clipMiddle(s.result ?? "", 900)}`
				: `[${s.kind} ${s.id}] ${clipMiddle(s.text, 1200)}`;
		if (spent + line.length > maxChars) break;
		lines.push(line);
		spent += line.length + 1;
	}
	return lines.join("\n");
}

export function buildJevQuestionsForBatch(batch: readonly PrunedEntry[]): Record<string, {
	type: "bool";
	instructions: string;
	criteria: { true: string; false: string };
}> {
	const questions: Record<string, { type: "bool"; instructions: string; criteria: { true: string; false: string } }> = {};
	for (const entry of batch) {
		const s = entry.step;
		questions[`result_${s.id}`] = {
			type: "bool",
			instructions: `Does tool step ${s.id} (${s.tool}: ${clipMiddle(s.callLine ?? "", 120)}) contain essential non-reproducible facts, IDs, schemas, or errors needed verbatim?`,
			criteria: { true: "Needed verbatim to resume work accurately", false: "Re-readable, superseded, or routine log bulk" },
		};
		questions[`essential_${s.id}`] = {
			type: "bool",
			instructions: `Is knowing tool step ${s.id} (${s.tool}) was executed part of the task decision trail?`,
			criteria: { true: "Matters for decisions or next steps", false: "Disposable exploratory noise" },
		};
	}
	return questions;
}

/** Stage 1b: Fold Jev classifier answers back into verdicts, rescuing `keep-verbatim` evidence. */
export function applyJevAnswers(
	batch: readonly PrunedEntry[],
	answers: Record<string, JevBoolAnswer | undefined>,
): number {
	let answeredCount = 0;
	for (const entry of batch) {
		if (entry.verdict !== "ask") continue;
		const rAns = answers[`result_${entry.step.id}`];
		const eAns = answers[`essential_${entry.step.id}`];
		if (!rAns || !eAns) {
			fallbackTruncate(entry);
			continue;
		}
		answeredCount += 1;
		const rProb = rAns.probabilities?.true ?? (rAns.choice ? 0.75 : 0.25);
		const eProb = eAns.probabilities?.true ?? (eAns.choice ? 0.75 : 0.25);
		entry.judgeScores = {
			call: eAns.choice,
			result: rAns.choice,
			essential: eAns.choice,
			resultProb: Number(rProb.toFixed(3)),
		};

		const tool = entry.step.tool ?? "tool";
		const callLine = entry.step.callLine ?? "";
		const result = entry.step.result ?? "";

		if (rAns.choice && (rProb >= 0.58 || eAns.choice)) {
			entry.verdict = "keep-verbatim";
			entry.reason = `jev keep (${rProb.toFixed(2)})`;
			entry.rendered = `${tool}(${callLine}) [JE-KEEP]:\n${clipMiddle(result, 2400)}`;
		} else if (!rAns.choice && !eAns.choice && rProb < 0.3 && eProb < 0.3) {
			entry.verdict = "drop";
			entry.reason = `jev noise (${rProb.toFixed(2)})`;
			entry.rendered = `${tool}(${callLine}) -> [dropped ${result.length} chars]`;
		} else {
			fallbackTruncate(entry);
			entry.reason = `jev border -> informative extract (${rProb.toFixed(2)})`;
		}
	}
	return answeredCount;
}

/** Resolve any remaining `ask` steps cleanly if Jev was offline or over budget. */
export function resolveRemainingAsks(entries: readonly PrunedEntry[]): void {
	for (const entry of entries) {
		if (entry.verdict === "ask") fallbackTruncate(entry);
	}
}

function fallbackTruncate(entry: PrunedEntry): void {
	const tool = entry.step.tool ?? "tool";
	const callLine = entry.step.callLine ?? "";
	const result = entry.step.result ?? "";
	const lines = informativeLines(result, 12);
	const excerpt = lines.length ? lines.join("\n") : clipMiddle(result, 500);
	entry.verdict = "truncate";
	entry.reason = "deterministic informative fallback";
	entry.rendered = `${tool}(${callLine}) [masked ${result.length} -> ${excerpt.length} chars]:\n${excerpt}`;
}

export interface RenderedPruneResult {
	prunedTranscript: string;
	retainedEvidenceBlock: string;
	stats: {
		totalSteps: number;
		keptVerbatim: number;
		truncated: number;
		dropped: number;
		rawChars: number;
		prunedChars: number;
		reductionRatio: number;
	};
}

/** Render the filtered signal transcript plus explicit verbatim evidence rescued by Jev or errors. */
export function renderPrunedResult(entries: readonly PrunedEntry[]): RenderedPruneResult {
	const lines: string[] = [];
	const retainedEvidence: string[] = [];
	let keptVerbatim = 0;
	let truncated = 0;
	let dropped = 0;
	let rawChars = 0;

	for (const entry of entries) {
		rawChars += entry.step.chars;
		if (entry.verdict === "drop") {
			dropped += 1;
			if (entry.rendered) lines.push(`[Tool omitted]: ${entry.rendered}`);
			continue;
		}
		if (entry.verdict === "truncate") {
			truncated += 1;
			if (entry.rendered) lines.push(`[Tool summary]: ${entry.rendered}`);
			continue;
		}
		if (entry.verdict === "keep-verbatim") {
			keptVerbatim += 1;
			const block = entry.rendered ?? entry.step.text;
			lines.push(`[Tool verbatim]: ${block}`);
			retainedEvidence.push(clipMiddle(block, 1200));
			continue;
		}
		// verdict === "keep"
		const rendered = entry.rendered ?? entry.step.text;
		if (entry.step.kind === "user") lines.push(`[User]: ${rendered}`);
		else if (entry.step.kind === "assistant") lines.push(`[Assistant]: ${rendered}`);
		else lines.push(`[Tool]: ${rendered}`);
	}

	const prunedTranscript = lines.join("\n\n");
	const prunedChars = prunedTranscript.length;
	const reductionRatio = rawChars > 0 ? Math.max(0, 1 - prunedChars / rawChars) : 0;
	const retainedEvidenceBlock = retainedEvidence.length
		? retainedEvidence.slice(-6).map((b) => `- ${b.replace(/\n+/g, "\n  ")}`).join("\n")
		: "";

	return {
		prunedTranscript,
		retainedEvidenceBlock,
		stats: {
			totalSteps: entries.length,
			keptVerbatim,
			truncated,
			dropped,
			rawChars,
			prunedChars,
			reductionRatio,
		},
	};
}

export function buildHybridSynthesisPrompt(params: {
	prunedTranscript: string;
	previousSummary?: string;
	customInstructions?: string;
}): string {
	const prev = params.previousSummary
		? `<previous-summary>\n${params.previousSummary}\n</previous-summary>\n\nPreserve still-valid constraints, resolved/unresolved blockers, and completed milestones from <previous-summary>; do not decay prior facts across compactions.\n\n`
		: "";
	const custom = params.customInstructions
		? `\nFocus instructions from user: ${params.customInstructions}\n`
		: "";

	return `${prev}Summarize the pre-filtered coding conversation below into a crisp, high-signal handoff markdown document. All raw noisy tool logs have already been masked or distilled; do NOT invent facts not present here.

Required sections (omit empty optional ones):
## Objective
## Key Decisions & Rationale
## Work Completed
## Blockers & Open Errors
## Constraints ("Do Not" Rules)
## Next Steps
${custom}
<filtered-conversation>
${params.prunedTranscript}
</filtered-conversation>`;
}
