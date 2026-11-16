/**
 * Sieve Semantic Cascade Router (System One Classifier Adapters + 4-Tier Auto-Thinking)
 *
 * Evaluates real prompt difficulty via Pi System One / Decision classifiers (Jev,
 * Cloudflare Clef, OpenAI GPT-6 Luna, Copilot Microsoft-Decision-1, or local llama.cpp
 * /v1/systemone) with deterministic heuristic fallback and zero-provider dead-end fallbacks.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ExtensionAPI, ExtensionContext, ModelRoute, ModelRouteRequest } from "@earendil-works/pi-coding-agent";
import { classifyWithAdapters, listAvailableClassifiers } from "../src/classifier-adapter.ts";
import { loadSieveConfig } from "../src/config.ts";
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
	selectModelFromCascades,
	THINK_RANK,
	XHIGH_RE,
	type Judgment,
	type RouteMessageLike,
	type Thinking,
} from "../src/router-core.ts";
import { getRuntimeState } from "../src/runtime-state.ts";

interface RouterState {
	tier: "fast" | "pro";
	thinking: Thinking;
}

const COOLDOWN_PATH = path.join(os.homedir(), ".pi", "agent", "router-cooldowns.json");
const config = loadSieveConfig();
const runtimeState = getRuntimeState();
runtimeState.autoThinking = config.autoThinking;
runtimeState.preferredClassifier = config.classifier;
const providerCooldownUntil = runtimeState.providerCooldownUntil;
const modelCooldownUntil = runtimeState.modelCooldownUntil;

const cascades = {
	compaction: config.cascades?.compaction ?? COMPACTION_CASCADE,
	fast: config.cascades?.fast ?? FAST_CASCADE,
	pro: config.cascades?.pro ?? PRO_CASCADE,
	free: config.cascades?.free ?? FREE_CASCADE,
};

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

async function classifyPrompt(
	text: string,
	manualFloor: Thinking,
	ctx: ExtensionContext,
	signal?: AbortSignal,
): Promise<Judgment> {
	if (text.trim().length < 24 && !HIGH_RE.test(text) && !XHIGH_RE.test(text)) {
		return heuristicJudge(text, manualFloor);
	}

	const adaptive = await classifyWithAdapters(
		ctx,
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
		{
			preferred: runtimeState.preferredClassifier,
			systemOne: config.systemOne,
			timeoutMs: 2500,
			signal,
		},
	);

	if (!adaptive) return heuristicJudge(text, manualFloor);
	const { result, usedClassifier } = adaptive;
	const kind = result.answers.task_kind?.type === "choice" ? result.answers.task_kind.choice : "implement";
	const complexity = result.answers.complexity?.type === "choice" ? result.answers.complexity.choice : "standard";
	const deepAns = result.answers.deep_reasoning;
	const deepReasoning = deepAns?.type === "bool" ? deepAns.probability >= 0.55 : false;
	return mapJevAnswers(kind, complexity, deepReasoning, manualFloor, usedClassifier);
}

function recordDispatch(provider: string, id: string, thinking: Thinking, judgment?: Judgment): void {
	runtimeState.lastDispatch = { provider, id, thinking };
	if (judgment) runtimeState.lastJudgment = judgment;
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
		description: "Clear provider/model cooldowns in Sieve Cascade Router",
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
			if (arg === "on") runtimeState.autoThinking = true;
			else if (arg === "off") runtimeState.autoThinking = false;
			else runtimeState.autoThinking = !runtimeState.autoThinking;
			ctx.ui.notify(`Auto-thinking ${runtimeState.autoThinking ? "enabled" : "disabled"}`, "info");
		},
	});

	pi.registerCommand("sieve-classifier", {
		description: "List available System One classifiers (Jev, Clef, GPT-6 Luna, Copilot, llama.cpp) or pin `auto|<provider/id>`",
		handler: async (args, ctx) => {
			const target = args.trim();
			const detected = await listAvailableClassifiers(ctx, runtimeState.preferredClassifier);
			if (!target) {
				const names = detected.map((m) => `${m.provider}/${m.id}`);
				if (config.systemOne) names.push(`systemone-http/${config.systemOne.model}`);
				ctx.ui.notify(
					`Classifier pin: ${runtimeState.preferredClassifier}\nDetected (${names.length}): ${names.join(", ") || "none (heuristic fallback active)"}`,
					"info",
				);
				return;
			}
			runtimeState.preferredClassifier = target;
			ctx.ui.notify(`Classifier preference set to: ${target}`, "info");
		},
	});

	pi.registerVirtualModel<RouterState>({
		provider: "router",
		id: "auto",
		name: "Sieve Auto Cascade (Jev/Clef + Smart Cascades)",
		thinkingLevels: ["off", "minimal", "low", "medium", "high", "xhigh", "max"],
		contextWindow: 1_000_000,
		maxTokens: 128_000,
		async route(request: ModelRouteRequest<RouterState>, ctx): Promise<ModelRoute<RouterState>> {
			const available = ctx.modelRegistry.getAvailable();

			if (request.reason === "direct") {
				const model = selectModelFromCascades(available, [cascades.compaction, cascades.fast], {
					preferReasoning: false,
					isCoolingDown,
				});
				if (!model) throw new Error("No available chat models for direct routing");
				recordDispatch(model.provider, model.id, "low");
				return { model, thinkingLevel: "low" };
			}

			if (request.reason === "retry" && request.failed) {
				const failed = { provider: request.failed.model.provider, id: request.failed.model.id };
				recordFailure(failed.provider, failed.id, request.failed.message?.errorMessage);
				const primary = request.state?.tier === "pro" ? cascades.pro : cascades.fast;
				const fallback = selectModelFromCascades(available, [primary, cascades.fast, cascades.free], {
					preferReasoning: request.state?.tier === "pro",
					isCoolingDown,
					skip: failed,
				});
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
			const judgment = runtimeState.autoThinking
				? await classifyPrompt(promptText, request.thinkingLevel, ctx, request.signal)
				: {
						source: "heuristic",
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
			const primaryList = usePro ? [cascades.pro, cascades.fast, cascades.free] : [cascades.fast, cascades.pro, cascades.free];
			const chosen = selectModelFromCascades(available, primaryList, {
				preferReasoning: usePro,
				isCoolingDown,
			});

			if (!chosen) throw new Error("No available chat models configured in Pi for router/auto");

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
		name: "Sieve Free Cascade (System One + Free Models)",
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
			const judgment = runtimeState.autoThinking
				? await classifyPrompt(promptText, request.thinkingLevel, ctx, request.signal)
				: heuristicJudge(promptText, request.thinkingLevel);
			const clamped = judgment.thinking === "xhigh" || judgment.thinking === "max" ? "high" : judgment.thinking;
			const prev = request.previous?.model;
			if (prev && !skip && !isCoolingDown(prev.provider, prev.id)) {
				recordDispatch(prev.provider, prev.id, clamped, judgment);
				return { model: prev, thinkingLevel: clamped };
			}
			const model = selectModelFromCascades(ctx.modelRegistry.getAvailable(), [cascades.free, cascades.fast], {
				preferReasoning: false,
				isCoolingDown,
				skip,
			});
			if (!model) throw new Error("No free or fallback chat models available");
			recordDispatch(model.provider, model.id, clamped, judgment);
			return { model, thinkingLevel: clamped };
		},
	});
}
