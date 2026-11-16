/**
 * Sieve Intentional Handoff (`/handoff <goal>`)
 *
 * Transfers focused context into a clean session around 40-60% utilization
 * instead of letting long sessions degrade into context rot.
 */
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { type Message, uuidv7 } from "@earendil-works/pi-ai";
import type { ExtensionAPI, SessionEntry } from "@earendil-works/pi-coding-agent";
import { BorderedLoader, convertToLlm, serializeConversation } from "@earendil-works/pi-coding-agent";
import { loadSieveConfig } from "../src/config.ts";
import { COMPACTION_CASCADE, FAST_CASCADE, FREE_CASCADE, selectModelFromCascades } from "../src/router-core.ts";

const SYSTEM_PROMPT = `You are a context transfer assistant. Given a conversation history and the user's goal for a new thread, generate a focused prompt that:

1. Summarizes relevant context from the conversation (decisions made, approaches taken, key findings)
2. Lists any relevant files that were discussed or modified
3. Clearly states the next task based on the user's goal
4. Is self-contained - the new thread should be able to proceed without the old conversation

Format your response as a concise, actionable prompt the user can send to start the new thread. Do not include any preamble.`;

function entryToMessage(entry: SessionEntry): AgentMessage | undefined {
	if (entry.type === "message") return entry.message;
	if (entry.type === "compaction") {
		return {
			role: "compactionSummary",
			summary: entry.summary,
			tokensBefore: entry.tokensBefore,
			timestamp: new Date(entry.timestamp).getTime(),
		};
	}
	return undefined;
}

function getHandoffMessages(branch: SessionEntry[]): AgentMessage[] {
	let compactionIndex = -1;
	for (let i = branch.length - 1; i >= 0; i--) {
		if (branch[i].type === "compaction") {
			compactionIndex = i;
			break;
		}
	}
	if (compactionIndex < 0) {
		return branch.map(entryToMessage).filter((m) => m !== undefined);
	}
	const compaction = branch[compactionIndex];
	const firstKeptIndex =
		compaction.type === "compaction" ? branch.findIndex((e) => e.id === compaction.firstKeptEntryId) : -1;
	const compactedBranch = [
		compaction,
		...(firstKeptIndex >= 0 ? branch.slice(firstKeptIndex, compactionIndex) : []),
		...branch.slice(compactionIndex + 1),
	];
	return compactedBranch.map(entryToMessage).filter((m) => m !== undefined);
}

export default function (pi: ExtensionAPI) {
	pi.registerCommand("handoff", {
		description: "Transfer focused context into a fresh session tab (saves tokens)",
		handler: async (args, ctx) => {
			if (ctx.mode !== "tui") {
				ctx.ui.notify("handoff requires interactive mode", "error");
				return;
			}
			const goal = args.trim();
			if (!goal) {
				ctx.ui.notify("Usage: /handoff <goal for new thread>", "error");
				return;
			}

			const messages = getHandoffMessages(ctx.sessionManager.getBranch());
			if (messages.length === 0) {
				ctx.ui.notify("No conversation to hand off", "error");
				return;
			}

			const avail = ctx.modelRegistry.getAvailable();
			const cfg = loadSieveConfig();
			const compList = cfg.cascades?.compaction ?? COMPACTION_CASCADE;
			const fastList = cfg.cascades?.fast ?? FAST_CASCADE;
			const freeList = cfg.cascades?.free ?? FREE_CASCADE;
			const summaryCandidates: Array<(typeof avail)[number]> = [];
			const seen = new Set<string>();
			for (let i = 0; i < 4; i++) {
				const picked = selectModelFromCascades(avail, [compList, fastList, freeList], {
					preferReasoning: false,
					isCoolingDown: (p, id) => seen.has(`${p}/${id}`),
				});
				if (!picked || seen.has(`${picked.provider}/${picked.id}`)) break;
				seen.add(`${picked.provider}/${picked.id}`);
				summaryCandidates.push(picked);
			}
			if (summaryCandidates.length === 0) {
				ctx.ui.notify("No available model for handoff", "error");
				return;
			}

			const conversationText = serializeConversation(convertToLlm(messages));
			const currentSessionFile = ctx.sessionManager.getSessionFile();

			const result = await ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
				const loader = new BorderedLoader(tui, theme, "Generating focused handoff prompt...");
				loader.onAbort = () => done(null);

				const doGenerate = async () => {
					const userMessage: Message = {
						role: "user",
						content: [
							{
								type: "text",
								text: `## Conversation History\n\n${conversationText}\n\n## User's Goal for New Thread\n\n${goal}`,
							},
						],
						timestamp: Date.now(),
					};

					for (const candidate of summaryCandidates) {
						if (loader.signal.aborted) return null;
						try {
							const response = await ctx.modelRegistry.complete(
								candidate,
								{ systemPrompt: SYSTEM_PROMPT, messages: [userMessage] },
								{
									signal: loader.signal,
									cacheRetention: "none",
									sessionId: uuidv7(),
								},
							);
							if (response.stopReason === "aborted") return null;
							if (response.stopReason === "error") continue;
							const text = response.content
								.filter((c): c is { type: "text"; text: string } => c.type === "text")
								.map((c) => c.text)
								.join("\n")
								.trim();
							if (text) return text;
						} catch {
							// Try next candidate in cascade.
						}
					}
					return null;
				};

				doGenerate().then(done).catch(() => done(null));
				return loader;
			});

			if (result === null) {
				ctx.ui.notify("Cancelled", "info");
				return;
			}

			const editedPrompt = await ctx.ui.editor("Edit handoff prompt", result);
			if (editedPrompt === undefined) {
				ctx.ui.notify("Cancelled", "info");
				return;
			}

			await ctx.newSession({
				parentSession: currentSessionFile,
				withSession: async (replacementCtx) => {
					replacementCtx.ui.setEditorText(editedPrompt);
					replacementCtx.ui.notify("Handoff ready in fresh session. Submit when ready.", "info");
				},
			});
		},
	});
}
