export type GuardrailVerdict =
	| { action: "allow" }
	| { action: "deny"; reason: string }
	| { action: "confirm"; command: string };

const HARD_BLOCK: ReadonlyArray<{ re: RegExp; reason: string }> = [
	{ re: /\bgh\s+pr\s+merge\b/i, reason: "Blocked by guardrail: gh pr merge is denied" },
	{ re: /\bgit\s+reset\s+--hard\b/i, reason: "Blocked by guardrail: git reset --hard is denied" },
	{ re: /\bgit\s+clean\s+-/i, reason: "Blocked by guardrail: git clean with flags is denied" },
];

const CONFIRM_PATTERNS: readonly RegExp[] = [/\bgit\s+push\b/i];

/** Evaluate a bash tool command against destructive-op and push policies. */
export function evaluateBashGuardrail(command: string): GuardrailVerdict {
	for (const rule of HARD_BLOCK) {
		if (rule.re.test(command)) {
			return { action: "deny", reason: rule.reason };
		}
	}
	if (CONFIRM_PATTERNS.some((re) => re.test(command))) {
		return { action: "confirm", command };
	}
	return { action: "allow" };
}
