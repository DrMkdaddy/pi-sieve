import assert from "node:assert/strict";
import test from "node:test";
import { getRuntimeState } from "../src/runtime-state.ts";
import { ctxBar, fmtTokens } from "../src/status-core.ts";
import { cleanTabTitle, shortTabLabel, workspaceTabHash } from "../src/tabs-core.ts";

test("runtime-state returns stable process-wide singleton", () => {
	const a = getRuntimeState();
	const b = getRuntimeState();
	assert.equal(a, b);
	a.lastDispatch = { provider: "antigravity-acp", id: "gemini-3.8-flash", thinking: "low" };
	assert.equal(b.lastDispatch?.id, "gemini-3.8-flash");
});

test("status formatting helpers clamp bars and scale token counts", () => {
	assert.equal(fmtTokens(420), "420");
	assert.equal(fmtTokens(12_500), "12.5k");
	assert.equal(fmtTokens(1_500_000), "1.50M");
	assert.equal(ctxBar(50), "███░░░");
	assert.equal(ctxBar(200), "██████");
	assert.equal(ctxBar(-5), "░░░░░░");
});

test("tab helpers collapse whitespace, bound length, and hash cwd deterministically", () => {
	assert.equal(cleanTabTitle("  fix\n  kv   cache  bug ", "abcdef1234"), "fix kv cache bug");
	assert.equal(cleanTabTitle("   ", "abcdef1234"), "abcdef12");
	assert.equal(cleanTabTitle("a".repeat(50), "fallback").length, 32);
	assert.equal(shortTabLabel("refactor-router", 8), "refactor");
	assert.equal(workspaceTabHash("/tmp/demo").length, 16);
	assert.equal(workspaceTabHash("/tmp/demo"), workspaceTabHash("/tmp/demo"));
});
