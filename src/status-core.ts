/** Format token counts compactly for status bar rendering. */
export function fmtTokens(n: number): string {
	if (n < 1000) return `${n}`;
	if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
	return `${(n / 1_000_000).toFixed(2)}M`;
}

/** Render a fixed-width context utilization gauge. */
export function ctxBar(pct: number, width = 6): string {
	const clamped = Math.max(0, Math.min(100, pct));
	const filled = Math.max(0, Math.min(width, Math.round((clamped / 100) * width)));
	return `${"█".repeat(filled)}${"░".repeat(width - filled)}`;
}
