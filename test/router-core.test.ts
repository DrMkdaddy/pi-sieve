import assert from "node:assert/strict";
import test from "node:test";
import {
	estimateContextTokens,
	heuristicJudge,
	isQuotaOrAuthError,
	lastUserText,
	mapJevAnswers,
	parseResetCooldownMs,
	stripInjectedBlocks,
} from "../src/router-core.ts";

test("stripInjectedBlocks removes hindsight and system-reminder wrappers cleanly", () => {
	const raw = "<hindsight_memory>Secret architect plan</hindsight_memory>\nReal prompt here\n<system-reminder>noise</system-reminder>";
	assert.equal(stripInjectedBlocks(raw), "Real prompt here");
});

test("lastUserText skips hidden Hindsight custom messages and recovers real human prompt", () => {
	const messages = [
		{ role: "user", content: [{ type: "text", text: "Say ok" }] },
		{
			role: "user",
			customType: "hindsight",
			display: false,
			content: "<hindsight_knowledge>Massive architecture review instructions...</hindsight_knowledge>",
		},
	];
	assert.equal(lastUserText(messages), "Say ok");
});

test("lastUserText skips inline unflagged hindsight-only messages cleanly", () => {
	const messages = [
		{ role: "user", content: "Fix typo in README" },
		{ role: "user", content: "<hindsight_knowledge>\n25 knowledge pages...\n</hindsight_knowledge>" },
	];
	assert.equal(lastUserText(messages), "Fix typo in README");
});

test("parseResetCooldownMs parses GoUsageLimitError reset durations", () => {
	const ms = parseResetCooldownMs("OpenCode Go usage limit reached (monthly, resets in 9d 17h).");
	assert.equal(ms, (9 * 24 + 17) * 60 * 60 * 1000);
	assert.equal(parseResetCooldownMs("resets in 4h"), 4 * 60 * 60 * 1000);
	assert.equal(parseResetCooldownMs("quota exceeded"), 12 * 60 * 60 * 1000);
});

test("isQuotaOrAuthError detects GoUsageLimitError and billing errors", () => {
	assert.equal(isQuotaOrAuthError('429: {"type":"GoUsageLimitError"}'), true);
	assert.equal(isQuotaOrAuthError("HTTP 503 temporarily unavailable"), false);
});

test("mapJevAnswers and heuristicJudge respect manual Tab floor", () => {
	const lowPrompt = mapJevAnswers("chat", "trivial", false, "low");
	assert.equal(lowPrompt.thinking, "low");

	const raisedFloor = mapJevAnswers("chat", "trivial", false, "high");
	assert.equal(raisedFloor.thinking, "high");

	const archPrompt = mapJevAnswers("plan", "architectural", true, "low");
	assert.equal(archPrompt.thinking, "xhigh");

	assert.equal(heuristicJudge("debug race condition in queue", "low").thinking, "xhigh");
});

test("estimateContextTokens scales ~chars/4", () => {
	const est = estimateContextTokens([
		{ role: "user", content: "a".repeat(400) },
		{ role: "assistant", content: [{ type: "text", text: "b".repeat(400) }] },
	]);
	assert.equal(est, 200);
});
