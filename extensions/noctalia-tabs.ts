/**
 * Noctalia Durable Session Tabs (OpenCode-style tab strip + persistent history)
 *
 * - Persists open tab order per workspace under ~/.pi/agent/cache/tabs/<hash>.json
 * - Keeps all session JSONL trees durably in ~/.pi/agent/sessions/ even when a tab is closed
 * - Auto-names untitled tabs from the first user message (<= 32 chars)
 * - Shows `<N` overflow, `!` attention/error badges, live busy indicator, and `+` new tab
 *
 * Commands:
 *   /tabs              Switch open tabs, reopen closed durable history, open +, or rename
 *   /tab-new [name]    Open a new session tab
 *   /tab-close         Close active tab from the strip (preserves durable history on disk)
 *   /tab-prev          Switch to previous open tab
 *   /tab-next          Switch to next open tab
 *   /tab-go <n|query>  Switch to tab by 1-based position or title search
 *   /tab-rename <name> Rename current session tab
 *   /tabs-toggle       Show/hide tab strip
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
	SessionManager,
	type ExtensionAPI,
	type ExtensionContext,
	type SessionInfo,
} from "@earendil-works/pi-coding-agent";
import { MouseRegion, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

interface TabItem {
	path: string;
	id: string;
	title: string;
	active: boolean;
	attention: boolean;
	busy: boolean;
	messageCount: number;
}

interface WorkspaceTabState {
	openPaths: string[];
	closedPaths: string[];
}

interface HitRegion {
	startX: number;
	endX: number;
	kind: "overflow" | "tab" | "new";
	index?: number;
}

const TABS_CACHE_DIR = join(homedir(), ".pi", "agent", "cache", "tabs");

function stateFileFor(cwd: string): string {
	const hash = createHash("sha256").update(cwd).digest("hex").slice(0, 16);
	return join(TABS_CACHE_DIR, `${hash}.json`);
}

function loadWorkspaceState(cwd: string): WorkspaceTabState {
	try {
		const file = stateFileFor(cwd);
		if (!existsSync(file)) return { openPaths: [], closedPaths: [] };
		const parsed = JSON.parse(readFileSync(file, "utf8")) as Partial<WorkspaceTabState>;
		return {
			openPaths: Array.isArray(parsed.openPaths) ? parsed.openPaths : [],
			closedPaths: Array.isArray(parsed.closedPaths) ? parsed.closedPaths : [],
		};
	} catch {
		return { openPaths: [], closedPaths: [] };
	}
}

function saveWorkspaceState(cwd: string, state: WorkspaceTabState): void {
	try {
		mkdirSync(TABS_CACHE_DIR, { recursive: true });
		writeFileSync(stateFileFor(cwd), JSON.stringify(state, null, 2));
	} catch {
		// Best-effort UI state persistence; durable session history remains in SessionManager.
	}
}

function cleanTitle(rawText: string, fallbackId: string): string {
	const cleaned = rawText.replace(/\s+/g, " ").trim();
	if (!cleaned) return fallbackId.slice(0, 8);
	return cleaned.length > 32 ? cleaned.slice(0, 32).trimEnd() : cleaned;
}

function shortLabel(title: string, maxChars: number): string {
	if (title.length <= maxChars) return title;
	return title.slice(0, Math.max(1, maxChars));
}

function currentHasError(ctx: ExtensionContext): boolean {
	for (const entry of [...ctx.sessionManager.getBranch()].reverse()) {
		if (entry.type === "message" && entry.message.role === "assistant") {
			const m = entry.message as AssistantMessage;
			return m.stopReason === "error";
		}
	}
	return false;
}

export default function (pi: ExtensionAPI) {
	let enabled = true;
	let isBusy = false;
	let openTabs: TabItem[] = [];
	let historySessions: SessionInfo[] = [];
	const attentionSessions = new Set<string>();
	let lastRender: (() => void) | undefined;

	function maybeAutoName(ctx: ExtensionContext): void {
		if (ctx.sessionManager.getSessionName()?.trim()) return;
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type === "message" && entry.message.role === "user") {
				const raw = entry.message.content;
				const text =
					typeof raw === "string"
						? raw
						: raw.flatMap((b) => (b.type === "text" ? [b.text] : [])).join(" ");
				const title = cleanTitle(text, ctx.sessionManager.getSessionId());
				if (title && title !== ctx.sessionManager.getSessionId().slice(0, 8)) {
					pi.setSessionName(title);
				}
				break;
			}
		}
	}

	async function refreshTabs(ctx: ExtensionContext): Promise<void> {
		if (!ctx.hasUI) return;
		const currentPath = ctx.sessionManager.getSessionFile() ?? "";
		const currentId = ctx.sessionManager.getSessionId();

		if (currentHasError(ctx)) {
			attentionSessions.add(currentId);
		} else {
			attentionSessions.delete(currentId);
		}

		let listed: SessionInfo[] = [];
		try {
			listed = await SessionManager.list(ctx.cwd, ctx.sessionManager.getSessionDir());
		} catch {
			listed = [];
		}
		historySessions = [...listed].sort((a, b) => b.modified.getTime() - a.modified.getTime());

		const byPath = new Map<string, SessionInfo>();
		for (const s of listed) {
			byPath.set(s.path, s);
		}

		const ws = loadWorkspaceState(ctx.cwd);
		const closedSet = new Set(ws.closedPaths);
		// Re-opening or starting the current session automatically promotes it to openTabs.
		if (currentPath) {
			closedSet.delete(currentPath);
			if (!ws.openPaths.includes(currentPath)) {
				ws.openPaths.push(currentPath);
			}
		}

		// Prune deleted session files from persisted open/closed lists, and auto-adopt recent sessions on first use.
		let validOpen = ws.openPaths.filter((p) => byPath.has(p) && !closedSet.has(p));
		if (validOpen.length === 0 && listed.length > 0) {
			validOpen = [...listed]
				.sort((a, b) => a.created.getTime() - b.created.getTime())
				.filter((s) => !closedSet.has(s.path))
				.slice(-12)
				.map((s) => s.path);
		} else {
			// Include any newly created session not yet recorded in open/closed sets.
			for (const s of [...listed].sort((a, b) => a.created.getTime() - b.created.getTime())) {
				if (!validOpen.includes(s.path) && !closedSet.has(s.path)) {
					validOpen.push(s.path);
				}
			}
		}

		const validClosed = Array.from(closedSet).filter((p) => byPath.has(p));
		saveWorkspaceState(ctx.cwd, { openPaths: validOpen, closedPaths: validClosed });

		const mapped: TabItem[] = validOpen.map((p) => {
			const s = byPath.get(p)!;
			const isActive = s.path === currentPath || s.id === currentId;
			return {
				path: s.path,
				id: s.id,
				title: cleanTitle(s.name || s.firstMessage, s.id),
				active: isActive,
				attention: attentionSessions.has(s.id),
				busy: isActive && isBusy,
				messageCount: s.messageCount,
			};
		});

		if (!mapped.some((t) => t.active)) {
			const name = ctx.sessionManager.getSessionName()?.trim() || "New tab";
			mapped.push({
				path: currentPath,
				id: currentId,
				title: name,
				active: true,
				attention: attentionSessions.has(currentId),
				busy: isBusy,
				messageCount: ctx.sessionManager.getBranch().length,
			});
		}

		openTabs = mapped;
		lastRender?.();
	}

	function attachBar(ctx: ExtensionContext): void {
		if (!ctx.hasUI) return;
		if (!enabled) {
			ctx.ui.setWidget("noctalia-tabs", undefined);
			return;
		}

		ctx.ui.setWidget(
			"noctalia-tabs",
			(tui, theme) => {
				let hitRegions: HitRegion[] = [];
				lastRender = () => tui.requestRender();

				const inner = {
					invalidate() {},
					render(width: number): string[] {
						hitRegions = [];
						if (openTabs.length === 0 || width < 16) return [];

						const plusStr = theme.bg("userMessageBg", theme.fg("accent", " + "));
						const plusWidth = visibleWidth(plusStr);

						const activeIdx = Math.max(
							0,
							openTabs.findIndex((t) => t.active),
						);

						const renderedTabs: Array<{ idx: number; text: string; w: number }> = [];
						for (let i = 0; i < openTabs.length; i++) {
							const t = openTabs[i];
							const badge = t.attention
								? theme.fg("customMessageLabel", "! ")
								: t.busy
									? theme.fg("accent", "• ")
									: "";
							if (t.active) {
								const label = shortLabel(t.title, Math.min(24, Math.max(10, Math.floor(width * 0.28))));
								const content = ` ${badge}${label} `;
								const styled = theme.bg("selectedBg", theme.fg("toolTitle", content));
								renderedTabs.push({ idx: i, text: styled, w: visibleWidth(styled) });
							} else {
								const label = shortLabel(t.title, 7);
								const content = ` ${badge}${label} `;
								const styled = t.attention
									? theme.bg("customMessageBg", theme.fg("muted", content))
									: theme.fg("dim", content);
								renderedTabs.push({ idx: i, text: styled, w: visibleWidth(styled) });
							}
						}

						const availForTabs = width - plusWidth - 5;
						let start = activeIdx;
						let end = activeIdx;
						let used = renderedTabs[activeIdx].w;

						while (start > 0 || end < renderedTabs.length - 1) {
							let grew = false;
							if (start > 0 && used + renderedTabs[start - 1].w <= availForTabs) {
								start -= 1;
								used += renderedTabs[start].w;
								grew = true;
							}
							if (end < renderedTabs.length - 1 && used + renderedTabs[end + 1].w <= availForTabs) {
								end += 1;
								used += renderedTabs[end].w;
								grew = true;
							}
							if (!grew) break;
						}

						let line = "";
						let cursorX = 0;
						if (start > 0) {
							const ov = theme.fg("dim", `<${start} `);
							const ovW = visibleWidth(ov);
							hitRegions.push({ startX: cursorX, endX: cursorX + ovW, kind: "overflow" });
							line += ov;
							cursorX += ovW;
						}

						for (let i = start; i <= end; i++) {
							const seg = renderedTabs[i];
							hitRegions.push({ startX: cursorX, endX: cursorX + seg.w, kind: "tab", index: seg.idx });
							line += seg.text;
							cursorX += seg.w;
						}

						const padLen = Math.max(0, width - cursorX - plusWidth);
						line += " ".repeat(padLen);
						cursorX += padLen;
						hitRegions.push({ startX: cursorX, endX: cursorX + plusWidth, kind: "new" });
						line += plusStr;

						return [truncateToWidth(line, width)];
					},
				};

				return new MouseRegion(inner, (event) => {
					if (event.type !== "click" || event.button !== "left") return undefined;
					const hit = hitRegions.find((r) => event.x >= r.startX && event.x < r.endX);
					if (!hit) return undefined;

					if (!ctx.ui.getEditorText().trim()) {
						if (hit.kind === "new") {
							ctx.ui.setEditorText("/tab-new");
							ctx.ui.notify("Press Enter to open a new session tab (/tab-new)", "info");
						} else if (hit.kind === "overflow") {
							ctx.ui.setEditorText("/tabs");
							ctx.ui.notify("Press Enter to open tab switcher (/tabs)", "info");
						} else if (hit.kind === "tab" && hit.index !== undefined) {
							ctx.ui.setEditorText(`/tab-go ${hit.index + 1}`);
							ctx.ui.notify(`Press Enter to switch to tab #${hit.index + 1}`, "info");
						}
					} else {
						ctx.ui.notify("Use /tabs, /tab-go <n>, /tab-prev, /tab-next, /tab-new, /tab-close", "info");
					}
					return { handled: true };
				});
			},
			{ placement: "aboveEditor" },
		);
	}

	pi.on("session_start", async (_event, ctx) => {
		isBusy = false;
		attachBar(ctx);
		await refreshTabs(ctx);
	});

	pi.on("agent_start", async (_event, ctx) => {
		isBusy = true;
		await refreshTabs(ctx);
	});

	pi.on("agent_end", async (_event, ctx) => {
		isBusy = false;
		maybeAutoName(ctx);
		await refreshTabs(ctx);
	});

	pi.registerCommand("tabs-toggle", {
		description: "Toggle Noctalia session tab bar",
		handler: async (_args, ctx) => {
			enabled = !enabled;
			attachBar(ctx);
			if (enabled) await refreshTabs(ctx);
			ctx.ui.notify(`Session tabs ${enabled ? "enabled" : "hidden"}`, "info");
		},
	});

	pi.registerCommand("tab-rename", {
		description: "Rename current session tab",
		handler: async (args, ctx) => {
			let name = args.trim();
			if (!name) {
				name = (await ctx.ui.input("Tab name:", ctx.sessionManager.getSessionName() ?? ""))?.trim() ?? "";
			}
			if (!name) return;
			pi.setSessionName(name);
			await refreshTabs(ctx);
			ctx.ui.notify(`Renamed tab to: ${name}`, "info");
		},
	});

	pi.registerCommand("tab-new", {
		description: "Open a new durable session tab (optional title)",
		handler: async (args, ctx) => {
			const title = args.trim();
			await ctx.newSession({
				setup: title
					? async (sm) => {
							sm.appendSessionInfo(title);
						}
					: undefined,
				withSession: async (newCtx) => {
					if (title) {
						newCtx.ui.notify(`Opened tab: ${title}`, "info");
					}
				},
			});
		},
	});

	pi.registerCommand("tab-close", {
		description: "Close current tab from the strip (preserves durable history on disk)",
		handler: async (_args, ctx) => {
			await refreshTabs(ctx);
			const currentPath = ctx.sessionManager.getSessionFile() ?? "";
			const activeIdx = Math.max(
				0,
				openTabs.findIndex((t) => t.active),
			);
			const remaining = openTabs.filter((t) => t.path !== currentPath && t.path);

			if (currentPath) {
				const ws = loadWorkspaceState(ctx.cwd);
				const nextOpen = ws.openPaths.filter((p) => p !== currentPath);
				const nextClosed = ws.closedPaths.includes(currentPath) ? ws.closedPaths : [...ws.closedPaths, currentPath];
				saveWorkspaceState(ctx.cwd, { openPaths: nextOpen, closedPaths: nextClosed });
			}

			if (remaining.length > 0) {
				const neighbor = remaining[Math.min(activeIdx, remaining.length - 1)];
				await ctx.switchSession(neighbor.path);
			} else {
				await ctx.newSession();
			}
		},
	});

	pi.registerCommand("tab-prev", {
		description: "Switch to previous open tab",
		handler: async (_args, ctx) => {
			await refreshTabs(ctx);
			if (openTabs.length < 2) {
				ctx.ui.notify("No other open tabs", "info");
				return;
			}
			const activeIdx = Math.max(
				0,
				openTabs.findIndex((t) => t.active),
			);
			const target = openTabs[(activeIdx - 1 + openTabs.length) % openTabs.length];
			if (target.path) await ctx.switchSession(target.path);
		},
	});

	pi.registerCommand("tab-next", {
		description: "Switch to next open tab",
		handler: async (_args, ctx) => {
			await refreshTabs(ctx);
			if (openTabs.length < 2) {
				ctx.ui.notify("No other open tabs", "info");
				return;
			}
			const activeIdx = Math.max(
				0,
				openTabs.findIndex((t) => t.active),
			);
			const target = openTabs[(activeIdx + 1) % openTabs.length];
			if (target.path) await ctx.switchSession(target.path);
		},
	});

	pi.registerCommand("tab-go", {
		description: "Switch to open tab by 1-based number or title query",
		handler: async (args, ctx) => {
			await refreshTabs(ctx);
			const q = args.trim();
			if (!q) return;
			const num = Number(q);
			let target: TabItem | undefined;
			if (Number.isInteger(num) && num >= 1 && num <= openTabs.length) {
				target = openTabs[num - 1];
			} else {
				const lower = q.toLowerCase();
				target = openTabs.find((t) => t.title.toLowerCase().includes(lower));
			}
			if (!target || !target.path) {
				ctx.ui.notify(`No open tab matching "${q}" (use /tabs to browse closed history)`, "warning");
				return;
			}
			await ctx.switchSession(target.path);
		},
	});

	pi.registerCommand("tabs", {
		description: "Switch open tabs, reopen closed durable history, create, or rename",
		handler: async (_args, ctx) => {
			await refreshTabs(ctx);
			const openPathSet = new Set(openTabs.map((t) => t.path));
			const closedHistory = historySessions.filter((s) => !openPathSet.has(s.path));

			const labels: string[] = [
				"+ New session tab",
				"Rename current tab",
				"Close current tab (keep history)",
				...openTabs.map((t, idx) => {
					const mark = t.active ? "●" : t.attention ? "!" : " ";
					return `${mark} ${idx + 1}. ${t.title} (${t.messageCount} msgs)`;
				}),
				...closedHistory.slice(0, 20).map((s, idx) => {
					const title = cleanTitle(s.name || s.firstMessage, s.id);
					return `↺ H${idx + 1}. ${title} (${s.messageCount} msgs, closed)`;
				}),
			];

			const choice = await ctx.ui.select("Session Tabs & Durable History", labels);
			if (!choice) return;
			if (choice === "+ New session tab") {
				await ctx.newSession();
				return;
			}
			if (choice === "Rename current tab") {
				const name = (await ctx.ui.input("Tab name:", ctx.sessionManager.getSessionName() ?? ""))?.trim();
				if (name) {
					pi.setSessionName(name);
					await refreshTabs(ctx);
				}
				return;
			}
			if (choice === "Close current tab (keep history)") {
				const currentPath = ctx.sessionManager.getSessionFile() ?? "";
				const remaining = openTabs.filter((t) => t.path !== currentPath && t.path);
				if (currentPath) {
					const ws = loadWorkspaceState(ctx.cwd);
					saveWorkspaceState(ctx.cwd, {
						openPaths: ws.openPaths.filter((p) => p !== currentPath),
						closedPaths: ws.closedPaths.includes(currentPath) ? ws.closedPaths : [...ws.closedPaths, currentPath],
					});
				}
				if (remaining.length > 0) await ctx.switchSession(remaining[0].path);
				else await ctx.newSession();
				return;
			}

			const openMatch = choice.match(/^[●! ] (\d+)\./);
			if (openMatch) {
				const target = openTabs[Number(openMatch[1]) - 1];
				if (target?.path && !target.active) {
					await ctx.switchSession(target.path);
				}
				return;
			}

			const histMatch = choice.match(/^↺ H(\d+)\./);
			if (histMatch) {
				const target = closedHistory[Number(histMatch[1]) - 1];
				if (target?.path) {
					await ctx.switchSession(target.path);
				}
			}
		},
	});
}
