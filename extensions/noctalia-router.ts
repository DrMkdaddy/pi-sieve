/**
 * Noctalia Semantic Cascade Router (powered by opencode/jev-1.13-free + 4-Tier Auto-Thinking)
 *
 * Uses Pi's built-in non-autoregressive System One classifier (`opencode/jev-1.13-free`, $0 free)
 * via `ctx.modelRegistry.classify()` to score task kind, difficulty, and reasoning need in a single
 * forward pass—falling back to local heuristics only if Jev is unavailable.
 *
 * Cache safety:
 * - Pins the chosen physical model (`request.previous.model`) across continuations and user turns
 *   so prompt caches stay warm. Only switches on `retry` failover, explicit `Tab` escalation to
 *   `high`+, or an `architectural` jump early in a session (< 24k context tokens).
 * - On Claude models, also preserves `thinkingLevel` across turns.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ExtensionAPI, ExtensionContext, ModelRoute, ModelRouteRequest } from "@earendil-works/pi-coding-agent";
import {
	COMPACTION_CASCADE,
	estimateContextTokens,
	FAST_CASCADE,
	FREE_CASCADE,
	heuristicJudge,
	HIGH_RE,
	isQuotaOrAuthError,
	lastUserText,
	mapJevAnswers,
	parseResetCooldownMs,
	PRO_CASCADE,
	THINK_RANK,
	XHIGH_RE,
	type Candidate,
	type Judgment,
	type RouteMessageLike,
	type Thinking,
} from "../src/router-core.ts";

interface RouterState {
	tier: "fast" | "pro";
	thinking: Thinking;
}

const COOLDOWN_PATH = path.join(os.homedir(), ".pi", "agent", "router-cooldowns.json");
const providerCooldownUntil = new Map<string, number>();
const modelCooldownUntil = new Map<string, number>();
let autoThinkingEnabled = true;

function loadCooldowns(): void {
	try {
		if (!fs.existsSync(COOLDOWN_PATH)) return;
		const parsed = JSON.parse(fs.readFileSync(COOLDOWN_PATH, "utf8")) as {
			providers?: Record<string, number>;
			models?: Record<string, number>;
		};
		const now = Date.now();
		for (const [k, until] of Object.entries(parsed.providers ?? {})) {
			if (typeof until === "number" && until > now) providerCooldownUntil.set(k, until);
		}
		for (const [k, until] of Object.entries(parsed.models ?? {})) {
			if (typeof until === "number" && until > now) modelCooldownUntil.set(k, until);
		}
	} catch {
		// Ignore corrupt cooldown cache.
	}
}

function saveCooldowns(): void {
	try {
		const now = Date.now();
		const providers: Record<string, number> = {};
		const models: Record<string, number> = {};
		for (const [k, until] of providerCooldownUntil.entries()) {
			if (until > now) providers[k] = until;
		}
		for (const [k, until] of modelCooldownUntil.entries()) {
			if (until > now) models[k] = until;
		}
		fs.mkdirSync(path.dirname(COOLDOWN_PATH), { recursive: true });
		fs.writeFileSync(COOLDOWN_PATH, JSON.stringify({ providers, models }, null, 2));
	} catch {
		// Ignore write errors.
	}
}

loadCooldowns();

const sharedState = {
	providerCooldownUntil,
	modelCooldownUntil,
	get autoThinking() {
		return autoThinkingEnabled;
	},
	lastDispatch: undefined as { provider: string; id: string; thinking: Thinking } | undefined,
	lastJudgment: undefined as Judgment | undefined,
};
(globalThis as Record<string, unknown>).__noctaliaRouterState = sharedState;

function modelKey(provider: string, id: string): string {
	return `${provider}/${id}`;
}

function recordFailure(provider: string, id: string, errMsg?: string): void {
	const now = Date.now();
	const msg = errMsg ?? "";
	if (isQuotaOrAuthError(msg)) {
		providerCooldownUntil.set(provider, now + parseResetCooldownMs(msg));
	}
	modelCooldownUntil.set(modelKey(provider, id), now + 5 * 60 * 1000);
	saveCooldowns();
}

function isCoolingDown(provider: string, id: string): boolean {
	const now = Date.now();
	return (providerCooldownUntil.get(provider) ?? 0) > now || (modelCooldownUntil.get(modelKey(provider, id)) ?? 0) > now;
}

async function classifyWithJev(
	text: string,
	manualFloor: Thinking,
	ctx: ExtensionContext,
	signal?: AbortSignal,
): Promise<Judgment> {
	if (text.trim().length < 24 && !HIGH_RE.test(text) && !XHIGH_RE.test(text)) {
		return heuristicJudge(text, manualFloor);
	}

	const jev =
		ctx.modelRegistry.findOfType("classifier", "opencode", "jev-1.13-free") ??
		ctx.modelRegistry.findOfType("classifier", "typesafe", "jev-latest");
	if (!jev) return heuristicJudge(text, manualFloor);

	try {
		const timeoutSignal = AbortSignal.timeout(2500);
		const combinedSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
		const res = await ctx.modelRegistry.classify(
			jev,
			{
				state: { prompt: text.slice(0, 12_000) },
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
			{ signal: combinedSignal },
		);

		if (res.stopReason !== "stop") return heuristicJudge(text, manualFloor);
		const kind = res.answers.task_kind?.type === "choice" ? res.answers.task_kind.choice : "implement";
		const complexity = res.answers.complexity?.type === "choice" ? res.answers.complexity.choice : "standard";
		const deepReasoning = res.answers.deep_reasoning?.type === "bool" ? res.answers.deep_reasoning.choice === true : false;
		return mapJevAnswers(kind, complexity, deepReasoning, manualFloor);
	} catch {
		return heuristicJudge(text, manualFloor);
	}
}

function pickAvailable(ctx: ExtensionContext, candidates: Candidate[], skip?: { provider: string; id: string }) {
	const avail = ctx.modelRegistry.getAvailable();
	const findAvail = (ignoreCooldown: boolean) => {
		for (const c of candidates) {
			if (skip && c.provider === skip.provider && c.id === skip.id) continue;
			if (!ignoreCooldown && isCoolingDown(c.provider, c.id)) continue;
			const found = avail.find((m) => m.provider === c.provider && m.id === c.id);
			if (found) return found;
		}
		return undefined;
	};
	return findAvail(false) ?? findAvail(true);
}

function recordDispatch(provider: string, id: string, thinking: Thinking, judgment?: Judgment): void {
	sharedState.lastDispatch = { provider, id, thinking };
	if (judgment) sharedState.lastJudgment = judgment;
}

export default function (pi: ExtensionAPI) {
	pi.on("turn_end", async (event, ctx) => {
		const msg = event.message;
		if (msg.role !== "assistant" || msg.stopReason !== "error") return;
		const err = msg.errorMessage ?? "";
		if (!err) return;
		recordFailure(msg.provider, msg.model, err);
		if (providerCooldownUntil.has(msg.provider)) {
			ctx.ui?.notify?.(
				`Router cooled down provider ${msg.provider} after limit/auth error; subsequent turns will skip it (/router-reset to clear).`,
				"warning",
			);
		}
	});

	pi.registerCommand("router-reset", {
		description: "Clear provider/model cooldowns in Noctalia Cascade Router",
		handler: async (_args, ctx) => {
			providerCooldownUntil.clear();
			modelCooldownUntil.clear();
			saveCooldowns();
			ctx.ui.notify("Router cooldowns cleared", "info");
		},
	});

	pi.registerCommand("auto-thinking", {
		description: "Toggle dynamic auto-thinking mode selection (`on` | `off`)",
		handler: async (args, ctx) => {
			const arg = args.trim().toLowerCase();
			if (arg === "on") autoThinkingEnabled = true;
			else if (arg === "off") autoThinkingEnabled = false;
			else autoThinkingEnabled = !autoThinkingEnabled;
			ctx.ui.notify(`Auto-thinking ${autoThinkingEnabled ? "enabled" : "disabled"}`, "info");
		},
	});

	pi.registerVirtualModel<RouterState>({
		provider: "router",
		id: "auto",
		name: "Auto Cascade (Jev-1.13 + Go + AGY Argon + ZAI)",
		thinkingLevels: ["off", "minimal", "low", "medium", "high", "xhigh", "max"],
		contextWindow: 1_000_000,
		maxTokens: 128_000,
		async route(request: ModelRouteRequest<RouterState>, ctx): Promise<ModelRoute<RouterState>> {
			if (request.reason === "direct") {
				const model = pickAvailable(ctx, COMPACTION_CASCADE) ?? pickAvailable(ctx, FAST_CASCADE);
				if (!model) throw new Error("No available model in COMPACTION_CASCADE");
				recordDispatch(model.provider, model.id, "low");
				return { model, thinkingLevel: "low" };
			}

			if (request.reason === "retry" && request.failed) {
				const failed = { provider: request.failed.model.provider, id: request.failed.model.id };
				recordFailure(failed.provider, failed.id, request.failed.message?.errorMessage);
				const tier = request.state?.tier === "pro" ? PRO_CASCADE : FAST_CASCADE;
				const fallback =
					pickAvailable(ctx, tier, failed) ??
					pickAvailable(ctx, FAST_CASCADE, failed) ??
					pickAvailable(ctx, FREE_CASCADE, failed);
				if (fallback) {
					const thinking = request.state?.thinking ?? request.thinkingLevel;
					recordDispatch(fallback.provider, fallback.id, thinking);
					return { model: fallback, thinkingLevel: thinking, state: request.state };
				}
			}

			if (request.reason === "continuation" && request.previous) {
				const thinking = (request.previous.thinkingLevel ?? request.state?.thinking ?? request.thinkingLevel) as Thinking;
				recordDispatch(request.previous.model.provider, request.previous.model.id, thinking);
				return { model: request.previous.model, thinkingLevel: thinking, state: request.state };
			}

			const promptText = lastUserText(request.messages as unknown as RouteMessageLike[]);
			const judgment = autoThinkingEnabled
				? await classifyWithJev(promptText, request.thinkingLevel, ctx, request.signal)
				: {
						source: "heuristic" as const,
						kind: "manual",
						complexity: "manual",
						deepReasoning: THINK_RANK[request.thinkingLevel] >= THINK_RANK.high,
						thinking: request.thinkingLevel,
					};
			const chosenThinking = judgment.thinking;

			const prev = request.previous?.model;
			const manualProEscalation =
				request.state?.tier === "fast" && THINK_RANK[request.thinkingLevel] >= THINK_RANK.high;
			const smallContextProJump =
				request.state?.tier === "fast" &&
				judgment.complexity === "architectural" &&
				judgment.deepReasoning &&
				estimateContextTokens(request.messages as unknown as RouteMessageLike[]) < 24_000;

			if (prev && !isCoolingDown(prev.provider, prev.id) && !manualProEscalation && !smallContextProJump) {
				const isClaude = prev.id.includes("claude");
				const stickyThinking = isClaude
					? ((request.previous?.thinkingLevel ?? chosenThinking) as Thinking)
					: chosenThinking;
				recordDispatch(prev.provider, prev.id, stickyThinking, judgment);
				return {
					model: prev,
					thinkingLevel: stickyThinking,
					state: request.state ?? { tier: "fast", thinking: stickyThinking },
				};
			}

			const usePro = THINK_RANK[chosenThinking] >= THINK_RANK.high;
			const chosen = usePro
				? (pickAvailable(ctx, PRO_CASCADE) ?? pickAvailable(ctx, FAST_CASCADE))
				: (pickAvailable(ctx, FAST_CASCADE) ?? pickAvailable(ctx, PRO_CASCADE));

			if (!chosen) {
				const freeFallback = pickAvailable(ctx, FREE_CASCADE);
				if (!freeFallback) throw new Error("No available models for router/auto");
				recordDispatch(freeFallback.provider, freeFallback.id, "medium", judgment);
				return { model: freeFallback, thinkingLevel: "medium", state: { tier: "fast", thinking: "medium" } };
			}

			recordDispatch(chosen.provider, chosen.id, chosenThinking, judgment);
			return {
				model: chosen,
				thinkingLevel: chosenThinking,
				state: { tier: usePro ? "pro" : "fast", thinking: chosenThinking },
			};
		},
	});

	pi.registerVirtualModel({
		provider: "router",
		id: "free",
		name: "Free Cascade (Jev-1.13 + LLM7 + OpenRouter/Groq/Cerebras)",
		thinkingLevels: ["off", "low", "medium", "high"],
		contextWindow: 200_000,
		maxTokens: 65_536,
		async route(request, ctx) {
			if (request.reason === "continuation" && request.previous) {
				const t = (request.previous.thinkingLevel ?? request.thinkingLevel) as Thinking;
				recordDispatch(request.previous.model.provider, request.previous.model.id, t);
				return { model: request.previous.model, thinkingLevel: t };
			}
			let skip: { provider: string; id: string } | undefined;
			if (request.reason === "retry" && request.failed) {
				skip = { provider: request.failed.model.provider, id: request.failed.model.id };
				recordFailure(skip.provider, skip.id, request.failed.message?.errorMessage);
			}
			const promptText = lastUserText(request.messages as unknown as RouteMessageLike[]);
			const judgment = autoThinkingEnabled
				? await classifyWithJev(promptText, request.thinkingLevel, ctx, request.signal)
				: heuristicJudge(promptText, request.thinkingLevel);
			const clamped = judgment.thinking === "xhigh" || judgment.thinking === "max" ? "high" : judgment.thinking;
			const prev = request.previous?.model;
			if (prev && !skip && !isCoolingDown(prev.provider, prev.id)) {
				recordDispatch(prev.provider, prev.id, clamped, judgment);
				return { model: prev, thinkingLevel: clamped };
			}
			const model = pickAvailable(ctx, FREE_CASCADE, skip) ?? pickAvailable(ctx, FREE_CASCADE);
			if (!model) throw new Error("No free models available");
			recordDispatch(model.provider, model.id, clamped, judgment);
			return { model, thinkingLevel: clamped };
		},
	});
}
