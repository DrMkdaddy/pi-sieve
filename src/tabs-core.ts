import { createHash } from "node:crypto";

/** Derive a deterministic 16-char workspace cache key from cwd. */
export function workspaceTabHash(cwd: string): string {
	return createHash("sha256").update(cwd).digest("hex").slice(0, 16);
}

/** Normalize raw prompt text into a single-line <= 32-char tab title. */
export function cleanTabTitle(rawText: string, fallbackId: string): string {
	const cleaned = rawText.replace(/\s+/g, " ").trim();
	if (!cleaned) return fallbackId.slice(0, 8);
	return cleaned.length > 32 ? cleaned.slice(0, 32).trimEnd() : cleaned;
}

/** Trim a tab label to fit narrow terminal tab strips. */
export function shortTabLabel(title: string, maxChars: number): string {
	if (title.length <= maxChars) return title;
	return title.slice(0, Math.max(1, maxChars));
}
