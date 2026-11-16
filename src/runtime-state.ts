import type { Judgment, Thinking } from "./router-core.ts";

export interface CompactionTelemetry {
	steps: number;
	prunePct: number;
	jevAnswered: number;
	usedModel: string;
	elapsedMs: number;
}

export interface SieveRuntimeState {
	providerCooldownUntil: Map<string, number>;
	modelCooldownUntil: Map<string, number>;
	autoThinking: boolean;
	preferredClassifier: string;
	lastDispatch?: { provider: string; id: string; thinking: Thinking };
	lastJudgment?: Judgment;
	lastCompaction?: CompactionTelemetry;
}

const KEY = Symbol.for("drmkdaddy.piSieve.runtimeState");

/** Return the process-wide typed runtime state shared across pi-sieve extensions. */
export function getRuntimeState(): SieveRuntimeState {
	const g = globalThis as Record<symbol, SieveRuntimeState | undefined>;
	if (!g[KEY]) {
		g[KEY] = {
			providerCooldownUntil: new Map<string, number>(),
			modelCooldownUntil: new Map<string, number>(),
			autoThinking: true,
			preferredClassifier: "auto",
		};
	}
	return g[KEY];
}
