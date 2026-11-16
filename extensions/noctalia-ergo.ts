/**
 * Noctalia Ergonomics (/copy, /diff)
 *
 * Addresses recurring workflow tells:
 * - Clean Wayland clipboard copy via `wl-copy` (no TTY line-wrap mangling)
 * - Fast git diff/status summary without leaving Pi or polluting model context
 */
import { execFileSync } from "node:child_process";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

function lastAssistantText(ctx: ExtensionContext): string {
	for (const entry of [...ctx.sessionManager.getBranch()].reverse()) {
		if (entry.type === "message" && entry.message.role === "assistant") {
			const m = entry.message as AssistantMessage;
			return m.content
				.filter((b): b is { type: "text"; text: string } => b.type === "text")
				.map((b) => b.text)
				.join("\n\n")
				.trim();
		}
	}
	return "";
}

function lastCodeBlock(text: string): string {
	const matches = Array.from(text.matchAll(/```[^\n]*\n([\s\S]*?)```/g));
	return matches.at(-1)?.[1]?.trim() ?? "";
}

function copyWayland(text: string): void {
	execFileSync("wl-copy", [], { input: text, stdio: ["pipe", "ignore", "ignore"] });
}

export default function (pi: ExtensionAPI) {
	pi.registerCommand("copy", {
		description: "Copy last assistant response (or `/copy code` for last fenced code block) to Wayland clipboard",
		handler: async (args, ctx) => {
			const text = lastAssistantText(ctx);
			if (!text) {
				ctx.ui.notify("No assistant response in this branch to copy", "warning");
				return;
			}
			const wantCode = args.trim().toLowerCase() === "code";
			const payload = wantCode ? lastCodeBlock(text) : text;
			if (!payload) {
				ctx.ui.notify("No fenced code block in last response", "warning");
				return;
			}
			try {
				copyWayland(payload);
				ctx.ui.notify(
					`Copied ${wantCode ? "code block" : "response"} (${payload.length} chars) to clipboard`,
					"info",
				);
			} catch (err) {
				ctx.ui.notify(`wl-copy failed: ${err instanceof Error ? err.message : String(err)}`, "error");
			}
		},
	});

	pi.registerCommand("diff-copy", {
		description: "Copy git diff (or git status if clean) to Wayland clipboard",
		handler: async (_args, ctx) => {
			try {
				const status = execFileSync("git", ["status", "--short"], {
					cwd: ctx.cwd,
					encoding: "utf8",
				}).trim();
				const full = execFileSync("git", ["diff"], { cwd: ctx.cwd, encoding: "utf8" });
				copyWayland(full || status || "clean");
				ctx.ui.notify("Copied git diff to clipboard", "info");
			} catch (err) {
				ctx.ui.notify(`git diff failed: ${err instanceof Error ? err.message : String(err)}`, "error");
			}
		},
	});
}
