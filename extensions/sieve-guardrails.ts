/**
 * Sieve Shell Guardrails
 *
 * Pre-execution bash policy gate:
 * - Deny: gh pr merge, git reset --hard, git clean -*
 * - Confirm: git push* (fail-closed in non-interactive runs)
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { evaluateBashGuardrail } from "../src/guardrails-core.ts";

export default function (pi: ExtensionAPI) {
	pi.on("tool_call", async (event, ctx) => {
		if (event.toolName !== "bash") return undefined;
		const cmd = String((event.input as { command?: string }).command ?? "");
		const verdict = evaluateBashGuardrail(cmd);

		if (verdict.action === "deny") {
			return { block: true, reason: verdict.reason };
		}
		if (verdict.action === "confirm") {
			if (!ctx.hasUI) {
				return { block: true, reason: "Blocked git push in non-interactive mode" };
			}
			const choice = await ctx.ui.select(`Confirm git push:\n\n  ${cmd}\n\nAllow?`, ["Allow", "Deny"]);
			if (choice !== "Allow") {
				return { block: true, reason: "git push denied by user" };
			}
		}
		return undefined;
	});
}
