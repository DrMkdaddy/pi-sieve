import type { Judgment, Thinking } from "./router-core.ts";

export interface CompactionTelemetry {
	steps: number;
	prunePct: number;
	jevAnswered: number;
	usedModel: string;
	elapsedMs: number;
}

export interface NoctaliaRuntimeState {
	providerCooldownUntil: Map<string, number>;
	modelCooldownUntil: Map<string, number>;
	autoThinking: boolean;
	lastDispatch?: { provider: string; id: string; thinking: Thinking };
	lastJudgment?: Judgment;
	lastCompaction?: CompactionTelemetry;
}

const KEY = Symbol.for("noctalia.pi.runtimeState");

/** Return the process-wide typed runtime state shared across Noctalia extensions. */
export function getRuntimeState(): NoctaliaRuntimeState {
	const g = globalThis as Record<symbol, NoctaliaRuntimeState | undefined>;
	if (!g[KEY]) {
		g[KEY] = {
			providerCooldownUntil: new Map<string, number>(),
			modelCooldownUntil: new Map<string, number>(),
			autoThinking: true,
		};
	}
	return g[KEY];
}
