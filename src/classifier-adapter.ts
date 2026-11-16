import type { ClassifierApi, ClassifierContext, ClassifierModel, ClassifierResult } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { SystemOneEndpointConfig } from "./config.ts";
import type { Candidate } from "./router-core.ts";

/**
 * Priority-ordered System One / Decision classifier adapters supported natively by Pi:
 * - TypeSafe Jev (OpenCode free/paid, OpenRouter, Cloudflare Workers AI, TypeSafe direct, Vercel AI Gateway)
 * - Cloudflare Clef (`clef-flash`, `clef`, `clef-omni` on Workers AI & OpenRouter)
 * - OpenAI Decisions API (`gpt-6-luna`)
 * - GitHub Copilot (`microsoft-decision-1`)
 * - Plus any dynamically registered `llama.cpp` Decision model (OpenJev, Laya, Kev, Julia-1, lev)
 */
export const DEFAULT_CLASSIFIER_CATALOG: readonly Candidate[] = [
	{ provider: "opencode", id: "jev-1.13-free" },
	{ provider: "cloudflare-workers-ai", id: "@cf/cloudflare/clef-flash" },
	{ provider: "openrouter", id: "cloudflare/clef-flash" },
	{ provider: "openrouter", id: "typesafe/jev-1.14" },
	{ provider: "openrouter", id: "typesafe/jev-1.13" },
	{ provider: "cloudflare-workers-ai", id: "typesafe/jev-1.14.0" },
	{ provider: "cloudflare-workers-ai", id: "typesafe/jev" },
	{ provider: "cloudflare-workers-ai", id: "@cf/cloudflare/clef" },
	{ provider: "cloudflare-workers-ai", id: "@cf/cloudflare/clef-omni" },
	{ provider: "openrouter", id: "cloudflare/clef" },
	{ provider: "openrouter", id: "cloudflare/clef-omni" },
	{ provider: "typesafe", id: "jev-latest" },
	{ provider: "vercel-ai-gateway", id: "typesafe-ai/jev" },
	{ provider: "openai", id: "gpt-6-luna" },
	{ provider: "github-copilot", id: "microsoft-decision-1" },
	{ provider: "opencode", id: "jev-1.13" },
];

export interface ResolvedClassifier {
	provider: string;
	id: string;
	kind: "registry" | "http-systemone";
}

export interface AdaptiveClassifyResponse {
	result: ClassifierResult;
	usedClassifier: string;
}

/** Order available Pi registry classifiers cleanly, honoring an optional `provider/id` preference. */
export async function listAvailableClassifiers(
	ctx: ExtensionContext,
	preferred = "auto",
): Promise<ClassifierModel<ClassifierApi>[]> {
	const available = [...(await ctx.modelRegistry.getAvailableOfType("classifier"))];
	const ordered: ClassifierModel<ClassifierApi>[] = [];
	const seen = new Set<string>();
	const pushIfPresent = (provider: string, id: string) => {
		const key = `${provider}/${id}`;
		if (seen.has(key)) return;
		const match = available.find((m) => m.provider === provider && m.id === id);
		if (match) {
			seen.add(key);
			ordered.push(match);
		}
	};

	if (preferred && preferred !== "auto" && preferred.includes("/")) {
		const idx = preferred.indexOf("/");
		pushIfPresent(preferred.slice(0, idx), preferred.slice(idx + 1));
	}
	for (const c of DEFAULT_CLASSIFIER_CATALOG) {
		pushIfPresent(c.provider, c.id);
	}
	// Include any local llama.cpp Decision models (OpenJev, Laya, Kev, Julia-1) or custom classifiers.
	for (const m of available) {
		pushIfPresent(m.provider, m.id);
	}
	return ordered;
}

/** Convert Pi `bool` questions into TypeSafe wire-protocol `noul` questions for custom `/v1/systemone`. */
export function toWireSystemOnePayload(modelId: string, context: ClassifierContext): Record<string, unknown> {
	const wireQuestions: Record<string, unknown> = {};
	for (const [id, q] of Object.entries(context.questions)) {
		if (q.type === "bool") {
			wireQuestions[id] = { type: "noul", instructions: q.instructions, criteria: q.criteria };
		} else {
			wireQuestions[id] = q;
		}
	}
	return {
		model: modelId,
		state: context.state,
		questions: wireQuestions,
	};
}

/** Parse wire `/v1/systemone` response (`noul` -> Pi `ClassifierBoolAnswer`). */
export function parseWireSystemOneAnswers(
	body: Record<string, unknown>,
	context: ClassifierContext,
): ClassifierResult["answers"] {
	const out: ClassifierResult["answers"] = {};
	for (const [id, q] of Object.entries(context.questions)) {
		const ans = body[id] as Record<string, unknown> | undefined;
		if (!ans || typeof ans !== "object") {
			throw new Error(`System One endpoint omitted answer for ${id}`);
		}
		if (q.type === "bool") {
			if (ans.type !== "noul" || typeof ans.noul !== "number") {
				throw new Error(`System One endpoint returned invalid noul answer for ${id}`);
			}
			out[id] = { type: "bool", probability: ans.noul };
		} else if (q.type === "choice") {
			if (ans.type !== "choice" || typeof ans.choice !== "string") {
				throw new Error(`System One endpoint returned invalid choice answer for ${id}`);
			}
			out[id] = {
				type: "choice",
				choice: ans.choice,
				probabilities: (ans.probabilities as Record<string, number>) ?? {},
				confidence: typeof ans.confidence === "number" ? ans.confidence : 0,
			};
		} else if (q.type === "score") {
			if (ans.type !== "score" || typeof ans.score !== "number") {
				throw new Error(`System One endpoint returned invalid score answer for ${id}`);
			}
			out[id] = {
				type: "score",
				score: ans.score,
				confidence: typeof ans.confidence === "number" ? ans.confidence : 0,
			};
		}
	}
	return out;
}

/** Direct HTTP `/v1/systemone` fallback for self-hosted llama.cpp Decision models or laya-serve. */
export async function classifyViaSystemOneHttp(
	endpoint: SystemOneEndpointConfig,
	context: ClassifierContext,
	signal?: AbortSignal,
): Promise<ClassifierResult> {
	const url = endpoint.url.endsWith("/systemone")
		? endpoint.url
		: `${endpoint.url.replace(/\/+$/, "")}/systemone`;
	const res = await fetch(url, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			...(endpoint.apiKey ? { Authorization: `Bearer ${endpoint.apiKey}` } : {}),
		},
		body: JSON.stringify(toWireSystemOnePayload(endpoint.model, context)),
		signal,
	});
	if (!res.ok) {
		throw new Error(`System One HTTP ${res.status}: ${await res.text()}`);
	}
	const json = (await res.json()) as Record<string, unknown>;
	return {
		api: "typesafe-system-one",
		provider: "systemone-http",
		model: endpoint.model,
		answers: parseWireSystemOneAnswers(json, context),
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

/**
 * Run typed classification across all configured Pi classifiers (Jev, Clef, GPT-6 Luna,
 * Microsoft Decision 1, llama.cpp), falling back to an optional local `/v1/systemone` server.
 */
export async function classifyWithAdapters(
	ctx: ExtensionContext,
	context: ClassifierContext,
	options: {
		preferred?: string;
		systemOne?: SystemOneEndpointConfig;
		timeoutMs?: number;
		signal?: AbortSignal;
	} = {},
): Promise<AdaptiveClassifyResponse | undefined> {
	const timeoutMs = options.timeoutMs ?? 2800;
	const candidates = await listAvailableClassifiers(ctx, options.preferred ?? "auto");

	for (const model of candidates) {
		if (options.signal?.aborted) return undefined;
		try {
			const timeoutSignal = AbortSignal.timeout(timeoutMs);
			const combined = options.signal ? AbortSignal.any([options.signal, timeoutSignal]) : timeoutSignal;
			const result = await ctx.modelRegistry.classify(model, context, { signal: combined });
			if (result.stopReason === "stop") {
				return { result, usedClassifier: `${model.provider}/${model.id}` };
			}
		} catch {
			// Cascade to next configured classifier (e.g. Jev -> Clef -> GPT-6 Luna).
		}
	}

	if (options.systemOne && !options.signal?.aborted) {
		try {
			const timeoutSignal = AbortSignal.timeout(timeoutMs);
			const combined = options.signal ? AbortSignal.any([options.signal, timeoutSignal]) : timeoutSignal;
			const result = await classifyViaSystemOneHttp(options.systemOne, context, combined);
			return { result, usedClassifier: `systemone-http/${options.systemOne.model}` };
		} catch {
			// All adapters exhausted; caller falls back cleanly to deterministic heuristics.
		}
	}

	return undefined;
}
