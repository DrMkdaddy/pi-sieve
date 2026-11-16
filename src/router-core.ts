export type Thinking = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export interface Candidate {
	provider: string;
	id: string;
}

export interface Judgment {
	source: string;
	kind: string;
	complexity: string;
	deepReasoning: boolean;
	thinking: Thinking;
}

export interface TextLikeBlock {
	type: string;
	text?: string;
}

export interface RouteMessageLike {
	role: string;
	content: string | readonly TextLikeBlock[];
	customType?: string;
	display?: boolean;
}

export const THINK_RANK: Record<Thinking, number> = {
	off: 0,
	minimal: 1,
	low: 2,
	medium: 3,
	high: 4,
	xhigh: 5,
	max: 6,
};

export const COMPACTION_CASCADE: Candidate[] = [
	{ provider: "opencode-go", id: "deepseek-v4.1-flash" },
	{ provider: "zai", id: "glm-5.3-flash" },
	{ provider: "llm7", id: "default" },
	{ provider: "antigravity-acp", id: "gemini-4-hydrogen" },
];

export const FAST_CASCADE: Candidate[] = [
	{ provider: "opencode-go", id: "deepseek-v4.1-flash" },
	{ provider: "antigravity-acp", id: "gemini-4-hydrogen" },
	{ provider: "zai", id: "glm-5.3-flash" },
	{ provider: "opencode-go", id: "glm-5.3-flash" },
	{ provider: "groq", id: "llama-3.3-70b-versatile" },
	{ provider: "cerebras", id: "llama-3.3-70b" },
	{ provider: "llm7", id: "default" },
];

export const PRO_CASCADE: Candidate[] = [
	{ provider: "antigravity-acp", id: "gemini-4-argon" },
	{ provider: "opencode-go", id: "deepseek-v4-pro" },
	{ provider: "antigravity-acp", id: "claude-sonnet-5-5" },
	{ provider: "zai", id: "glm-5.3" },
	{ provider: "antigravity-acp", id: "gemini-4-hydrogen" },
];

export const FREE_CASCADE: Candidate[] = [
	{ provider: "llm7", id: "default" },
	{ provider: "llm7", id: "fast" },
	{ provider: "openrouter", id: "qwen/qwen3-coder:free" },
	{ provider: "openrouter", id: "deepseek/deepseek-chat-v3-0324:free" },
	{ provider: "groq", id: "llama-3.3-70b-versatile" },
	{ provider: "cerebras", id: "llama-3.3-70b" },
	{ provider: "nvidia", id: "deepseek-ai/deepseek-v3.2" },
	{ provider: "opencode", id: "deepseek-v4.1-flash-free" },
	{ provider: "opencode", id: "glm-5.3-flash-free" },
	{ provider: "opencode-go", id: "beam-free" },
];

export const XHIGH_RE =
	/\b(race condition|deadlock|memory leak|heisenbug|still failing|broken again|root cause|deep dive|security audit|vulnerability|exploit)\b/i;
export const HIGH_RE =
	/\b(architect(?:ure)?|design|plan|refactor|security|audit|review|debug(?:ging)?|migration|orchestrat|concurrent|concurrency|async)\b/i;
export const MEDIUM_RE =
	/\b(implement|build|create|add|fix|test|update|rewrite|write|endpoint|api|schema|research|compare|investigate|mcp|extension|plugin|hook)\b/i;

/** Parse provider quota reset hints such as "resets in 9d 17h" (clamped 1h..14d). */
export function parseResetCooldownMs(errMsg: string): number {
	const dHM = errMsg.match(/resets in\s+(\d+)\s*d(?:\s+(\d+)\s*h)?/i);
	if (dHM) {
		const days = Number(dHM[1] ?? 0);
		const hours = Number(dHM[2] ?? 0);
		return Math.min(14 * 24, Math.max(1, days * 24 + hours)) * 60 * 60 * 1000;
	}
	const hM = errMsg.match(/resets in\s+(\d+)\s*h/i);
	if (hM) {
		return Math.min(14 * 24, Math.max(1, Number(hM[1] ?? 1))) * 60 * 60 * 1000;
	}
	return 12 * 60 * 60 * 1000;
}

export function isQuotaOrAuthError(errMsg: string): boolean {
	const msg = errMsg.toLowerCase();
	return (
		msg.includes("usage limit") ||
		msg.includes("gousagelimiterror") ||
		msg.includes("freeusagelimiterror") ||
		msg.includes("monthly") ||
		msg.includes("quota") ||
		msg.includes("insufficient") ||
		msg.includes("balance") ||
		msg.includes("402") ||
		msg.includes("authentication") ||
		msg.includes("invalid") ||
		msg.includes("401")
	);
}

export function extractText(content: RouteMessageLike["content"]): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content.flatMap((b) => (b.type === "text" && typeof b.text === "string" ? [b.text] : [])).join("\n");
}

/** Remove harness-injected memory/reminder blocks so classifiers score only real user text. */
export function stripInjectedBlocks(raw: string): string {
	return raw
		.replace(/<hindsight_[a-z0-9_]+>[\s\S]*?<\/hindsight_[a-z0-9_]+>/gi, "")
		.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/gi, "")
		.trim();
}

export function lastUserText(messages: readonly RouteMessageLike[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i];
		if (m.role !== "user") continue;
		if (m.customType || m.display === false) continue;
		const cleaned = stripInjectedBlocks(extractText(m.content));
		if (cleaned) return cleaned;
	}
	return "";
}

export function estimateContextTokens(messages: readonly RouteMessageLike[]): number {
	let chars = 0;
	for (const m of messages) {
		chars += extractText(m.content).length;
	}
	return Math.ceil(chars / 4);
}

export function heuristicJudge(text: string, manualFloor: Thinking): Judgment {
	let target: Thinking = "low";
	let kind = "chat";
	let complexity = "trivial";
	let deepReasoning = false;
	if (XHIGH_RE.test(text)) {
		target = "xhigh";
		kind = "debug";
		complexity = "architectural";
		deepReasoning = true;
	} else if (HIGH_RE.test(text)) {
		target = "high";
		kind = "plan";
		complexity = "complex";
		deepReasoning = true;
	} else if (MEDIUM_RE.test(text) || text.includes("\n") || text.length >= 140) {
		target = "medium";
		kind = "implement";
		complexity = "standard";
	}
	const thinking = THINK_RANK[manualFloor] > THINK_RANK[target] ? manualFloor : target;
	return { source: "heuristic", kind, complexity, deepReasoning, thinking };
}

export function mapJevAnswers(
	kind: string,
	complexity: string,
	deepReasoning: boolean,
	manualFloor: Thinking,
	source = "jev-1.13-free",
): Judgment {
	let target: Thinking = "medium";
	if (complexity === "trivial" && (kind === "chat" || kind === "explain")) target = "low";
	else if (complexity === "architectural" && deepReasoning) target = "xhigh";
	else if (
		complexity === "complex" ||
		complexity === "architectural" ||
		kind === "plan" ||
		(kind === "debug" && deepReasoning)
	) {
		target = "high";
	} else if (complexity === "trivial") {
		target = "low";
	}
	const thinking = THINK_RANK[manualFloor] > THINK_RANK[target] ? manualFloor : target;
	return { source, kind, complexity, deepReasoning, thinking };
}

export interface ChatModelLike {
	provider: string;
	id: string;
	reasoning?: boolean;
	cost?: { input?: number };
}

/**
 * Pick the highest-priority available chat model matching ordered candidate cascades,
 * falling back cleanly to any configured non-router chat model so pi-sieve works on any setup.
 */
export function selectModelFromCascades<T extends ChatModelLike>(
	available: readonly T[],
	cascades: ReadonlyArray<readonly Candidate[]>,
	options: {
		preferReasoning: boolean;
		isCoolingDown?: (provider: string, id: string) => boolean;
		skip?: Candidate;
	},
): T | undefined {
	const skipKey = options.skip ? `${options.skip.provider}/${options.skip.id}` : undefined;
	const nonRouter = available.filter((m) => m.provider !== "router");

	const pickFromList = (ignoreCooldown: boolean): T | undefined => {
		for (const list of cascades) {
			for (const c of list) {
				const key = `${c.provider}/${c.id}`;
				if (skipKey && key === skipKey) continue;
				if (!ignoreCooldown && options.isCoolingDown?.(c.provider, c.id)) continue;
				const match = nonRouter.find((m) => m.provider === c.provider && m.id === c.id);
				if (match) return match;
			}
		}
		return undefined;
	};

	const exact = pickFromList(false) ?? pickFromList(true);
	if (exact) return exact;

	const pool = nonRouter.filter((m) => `${m.provider}/${m.id}` !== skipKey);
	const healthy = pool.filter((m) => !options.isCoolingDown?.(m.provider, m.id));
	const candidates = healthy.length > 0 ? healthy : pool;
	if (candidates.length === 0) return undefined;

	return [...candidates].sort((a, b) => {
		const aScore = (a.reasoning ? 1 : 0) * (options.preferReasoning ? 1 : -1);
		const bScore = (b.reasoning ? 1 : 0) * (options.preferReasoning ? 1 : -1);
		if (aScore !== bScore) return bScore - aScore;
		const aCost = a.cost?.input ?? 0;
		const bCost = b.cost?.input ?? 0;
		return options.preferReasoning ? bCost - aCost : aCost - bCost;
	})[0];
}
