/**
 * Sieve Workspace Ergonomics (`/copy`, `/copy code`, `/diff-copy`)
 *
 * Cross-platform clipboard export across Wayland (`wl-copy`), X11 (`xclip` / `xsel`),
 * and macOS (`pbcopy`), keeping bulky copy helpers out of model context.
 */
import { execFileSync } from "node:child_process";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { copyToClipboard } from "../src/clipboard-core.ts";

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

export default function (pi: ExtensionAPI) {
	pi.registerCommand("copy", {
		description: "Copy last assistant response (or `/copy code` for last fenced code block) to system clipboard",
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
				const backend = copyToClipboard(payload);
				ctx.ui.notify(
					`Copied ${wantCode ? "code block" : "response"} (${payload.length} chars) via ${backend.label}`,
					"info",
				);
			} catch (err) {
				ctx.ui.notify(`Clipboard failed: ${err instanceof Error ? err.message : String(err)}`, "error");
			}
		},
	});

	pi.registerCommand("diff-copy", {
		description: "Copy git diff (or git status if clean) to system clipboard",
		handler: async (_args, ctx) => {
			try {
				const status = execFileSync("git", ["status", "--short"], { cwd: ctx.cwd, encoding: "utf8" }).trim();
				const full = execFileSync("git", ["diff"], { cwd: ctx.cwd, encoding: "utf8" });
				const backend = copyToClipboard(full || status || "clean");
				ctx.ui.notify(`Copied git diff via ${backend.label}`, "info");
			} catch (err) {
				ctx.ui.notify(`git diff failed: ${err instanceof Error ? err.message : String(err)}`, "error");
			}
		},
	});
}
