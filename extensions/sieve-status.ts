/**
 * Sieve Statusline & Diagnostics (`/info`, `/footer`)
 *
 * Displays active route, Jev classification judgment, token/cache R/W counts,
 * context utilization bar, USD cost, git branch, and last hybrid compaction metrics.
 */
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { getRuntimeState } from "../src/runtime-state.ts";
import { ctxBar, fmtTokens } from "../src/status-core.ts";

function collectSessionStats(ctx: ExtensionContext) {
	let input = 0;
	let output = 0;
	let cacheRead = 0;
	let cacheWrite = 0;
	let cost = 0;
	let turns = 0;
	let lastRouteModel: string | undefined;
	let lastContextTokens = 0;

	for (const entry of ctx.sessionManager.getBranch()) {
		if (entry.type === "message" && entry.message.role === "assistant") {
			const m = entry.message as AssistantMessage;
			turns += 1;
			input += m.usage?.input ?? 0;
			output += m.usage?.output ?? 0;
			cacheRead += m.usage?.cacheRead ?? 0;
			cacheWrite += m.usage?.cacheWrite ?? 0;
			cost += m.usage?.cost?.total ?? 0;
			if (m.model) lastRouteModel = `${m.provider}/${m.model}`;
			const total = m.usage?.totalTokens ?? 0;
			if (total > 0) lastContextTokens = total;
		}
	}

	const ctxWindow = ctx.model?.contextWindow ?? 0;
	const pct = ctxWindow > 0 && lastContextTokens > 0 ? Math.min(100, Math.round((lastContextTokens / ctxWindow) * 100)) : 0;
	return { input, output, cacheRead, cacheWrite, cost, turns, lastRouteModel, lastContextTokens, ctxWindow, pct };
}

function attachFooter(ctx: ExtensionContext): void {
	if (!ctx.hasUI) return;
	ctx.ui.setFooter((tui, theme, footerData) => {
		const unsub = footerData.onBranchChange(() => tui.requestRender());

		return {
			dispose: unsub,
			invalidate() {},
			render(width: number): string[] {
				const s = collectSessionStats(ctx);
				const selected = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "no-model";
				const runtimeState = getRuntimeState();
				const dispatch = runtimeState.lastDispatch;
				const routed =
					selected.startsWith("router/") && dispatch
						? ` → ${dispatch.provider}/${dispatch.id}`
						: s.lastRouteModel && s.lastRouteModel !== selected && selected.startsWith("router/")
							? ` → ${s.lastRouteModel}`
							: "";
				const thinking =
					selected.startsWith("router/") && dispatch
						? `${dispatch.thinking}${runtimeState.autoThinking ? ":auto" : ""}`
						: (ctx.thinkingLevel ?? "medium");

				const statuses = Array.from(footerData.getExtensionStatuses().values())
					.filter(Boolean)
					.join(" · ");
				const branch = footerData.getGitBranch();

				const dot = theme.fg("accent", "●");
				const modelPart = `${dot} ${theme.fg("text", selected)}${theme.fg("dim", routed)}`;
				const thinkPart = theme.fg("bashMode", `[${thinking}]`);
				const cachePart =
					s.cacheRead > 0 || s.cacheWrite > 0
						? ` R${fmtTokens(s.cacheRead)}${s.cacheWrite > 0 ? ` W${fmtTokens(s.cacheWrite)}` : ""}`
						: "";
				const tokenPart = theme.fg("muted", `↑${fmtTokens(s.input)} ↓${fmtTokens(s.output)}${cachePart}`);
				const ctxTone = s.pct >= 80 ? "error" : s.pct >= 60 ? "warning" : "dim";
				const ctxPart = s.ctxWindow > 0 ? theme.fg(ctxTone, ` [${ctxBar(s.pct)}] ${s.pct}%`) : "";
				const costPart = s.cost > 0 ? theme.fg("accent", ` $${s.cost.toFixed(3)}`) : "";

				const left = `${modelPart} ${thinkPart} ${tokenPart}${ctxPart}${costPart}`;
				const branchPart = branch ? theme.fg("accent", `git:${branch}`) : "";
				const statusPart = statuses ? theme.fg("dim", statuses) : "";
				const right = [statusPart, branchPart].filter(Boolean).join(theme.fg("dim", " · "));

				const lw = visibleWidth(left);
				const rw = visibleWidth(right);
				if (lw + rw + 2 <= width) {
					const pad = " ".repeat(width - lw - rw);
					return [truncateToWidth(left + pad + right, width)];
				}
				return [truncateToWidth(left, width), ...(right ? [truncateToWidth(right, width)] : [])];
			},
		};
	});
}

export default function (pi: ExtensionAPI) {
	let enabled = true;

	pi.on("session_start", async (_event, ctx) => {
		if (enabled) attachFooter(ctx);
	});

	pi.registerCommand("footer", {
		description: "Toggle Sieve telemetry footer",
		handler: async (_args, ctx) => {
			enabled = !enabled;
			if (enabled) {
				attachFooter(ctx);
				ctx.ui.notify("Sieve footer enabled", "info");
			} else {
				ctx.ui.setFooter(undefined);
				ctx.ui.notify("Default footer restored", "info");
			}
		},
	});

	pi.registerCommand("info", {
		description: "Show active models, provider cooldowns, compaction metrics, and commands",
		handler: async (_args, ctx) => {
			const s = collectSessionStats(ctx);
			const selected = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "none";
			const avail = ctx.modelRegistry.getAvailable();
			const providers = Array.from(new Set(avail.map((m) => m.provider))).sort();

			const runtimeState = getRuntimeState();
			const compactStats = runtimeState.lastCompaction;

			const now = Date.now();
			const coolingProviders = Array.from(runtimeState.providerCooldownUntil.entries())
				.filter(([, until]) => until > now)
				.map(([p, until]) => `${p} (${Math.ceil((until - now) / 60000)}m)`);
			const coolingModels = Array.from(runtimeState.modelCooldownUntil.entries())
				.filter(([, until]) => until > now)
				.map(([m, until]) => `${m} (${Math.ceil((until - now) / 60000)}m)`);
			const dispatched = runtimeState.lastDispatch
				? `${runtimeState.lastDispatch.provider}/${runtimeState.lastDispatch.id} [${runtimeState.lastDispatch.thinking}]`
				: (s.lastRouteModel ?? "pending first turn");
			const j = runtimeState.lastJudgment;
			const judgmentLine = j
				? `${j.source}: kind=${j.kind}, complexity=${j.complexity}, deep=${j.deepReasoning}`
				: "none yet";
			const compactLine = compactStats
				? `${compactStats.prunePct}% pruned (${compactStats.steps} steps, Jev=${compactStats.jevAnswered}) -> ${compactStats.usedModel} in ${compactStats.elapsedMs}ms`
				: "none this session";

			const lines = [
				`Selected:   ${selected} (floor: ${ctx.thinkingLevel ?? "low"}, auto-thinking: ${runtimeState.autoThinking ? "on" : "off"})`,
				`Dispatched: ${dispatched}`,
				`Judgment:   ${judgmentLine}`,
				`Compaction: ${compactLine}`,
				`Session:    ${s.turns} turns · ↑${fmtTokens(s.input)} ↓${fmtTokens(s.output)} R${fmtTokens(s.cacheRead)} · ctx ${s.pct}% (${fmtTokens(s.lastContextTokens)}/${fmtTokens(s.ctxWindow)}) · $${s.cost.toFixed(4)}`,
				`Providers:  ${providers.join(", ")} (${avail.length} models)`,
				`Cooldowns:  ${coolingProviders.length || coolingModels.length ? [...coolingProviders, ...coolingModels].join(", ") : "none"}`,
				`Commands:   /tabs · /handoff · /compact · /copy · /diff-copy · /router-reset · /auto-thinking`,
			];
			ctx.ui.notify(lines.join("\n"), "info");
		},
	});
}
