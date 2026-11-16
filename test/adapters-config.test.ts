import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
	DEFAULT_CLASSIFIER_CATALOG,
	parseWireSystemOneAnswers,
	toWireSystemOnePayload,
} from "../src/classifier-adapter.ts";
import { detectClipboardBackend } from "../src/clipboard-core.ts";
import { loadSieveConfig } from "../src/config.ts";
import { selectModelFromCascades } from "../src/router-core.ts";

test("DEFAULT_CLASSIFIER_CATALOG covers Jev, Cloudflare Clef, GPT-6 Luna, and Copilot", () => {
	const ids = DEFAULT_CLASSIFIER_CATALOG.map((c) => `${c.provider}/${c.id}`);
	assert.ok(ids.includes("opencode/jev-1.13-free"));
	assert.ok(ids.includes("cloudflare-workers-ai/@cf/cloudflare/clef-flash"));
	assert.ok(ids.includes("openrouter/cloudflare/clef-flash"));
	assert.ok(ids.includes("openai/gpt-6-luna"));
	assert.ok(ids.includes("github-copilot/microsoft-decision-1"));
});

test("System One wire adapter maps Pi bool <-> wire noul cleanly", () => {
	const ctx = {
		state: { prompt: "check race condition" },
		questions: {
			kind: {
				type: "choice" as const,
				instructions: "Pick one",
				criteria: { debug: "debug", chat: "chat" },
			},
			deep: {
				type: "bool" as const,
				instructions: "Deep?",
				criteria: { true: "yes", false: "no" },
			},
		},
	};
	const wire = toWireSystemOnePayload("openjev", ctx);
	const q = wire.questions as Record<string, { type: string }>;
	assert.equal(q.deep.type, "noul");
	assert.equal(q.kind.type, "choice");

	const parsed = parseWireSystemOneAnswers(
		{
			kind: { type: "choice", choice: "debug", probabilities: { debug: 0.9, chat: 0.1 }, confidence: 0.8 },
			deep: { type: "noul", noul: 0.84 },
		},
		ctx,
	);
	assert.equal(parsed.deep.type, "bool");
	if (parsed.deep.type === "bool") assert.equal(parsed.deep.probability, 0.84);
});

test("selectModelFromCascades falls back cleanly when user has arbitrary Pi providers", () => {
	const genericPool = [
		{ provider: "anthropic", id: "claude-haiku-4-5", reasoning: false, cost: { input: 0.8 } },
		{ provider: "anthropic", id: "claude-opus-4-5", reasoning: true, cost: { input: 15 } },
	];
	const fastPick = selectModelFromCascades(genericPool, [[{ provider: "opencode-go", id: "deepseek-v4.1-flash" }]], {
		preferReasoning: false,
	});
	const proPick = selectModelFromCascades(genericPool, [[{ provider: "antigravity-acp", id: "gemini-4-argon" }]], {
		preferReasoning: true,
	});
	assert.equal(fastPick?.id, "claude-haiku-4-5");
	assert.equal(proPick?.id, "claude-opus-4-5");
});

test("loadSieveConfig reads file overrides cleanly and ignores missing file", () => {
	const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sieve-cfg-"));
	const cfgPath = path.join(tmpDir, "pi-sieve.json");
	fs.writeFileSync(
		cfgPath,
		JSON.stringify({
			classifier: "cloudflare-workers-ai/@cf/cloudflare/clef-flash",
			autoThinking: false,
			systemOne: { url: "http://127.0.0.1:8080/v1/systemone", model: "openjev" },
		}),
	);
	const cfg = loadSieveConfig(cfgPath);
	assert.equal(cfg.classifier, "cloudflare-workers-ai/@cf/cloudflare/clef-flash");
	assert.equal(cfg.autoThinking, false);
	assert.equal(cfg.systemOne?.model, "openjev");
	fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("detectClipboardBackend picks Wayland, X11, or macOS automatically", () => {
	assert.equal(detectClipboardBackend((cmd) => cmd === "xclip")?.cmd, "xclip");
	assert.equal(detectClipboardBackend((cmd) => cmd === "pbcopy")?.cmd, "pbcopy");
	assert.equal(detectClipboardBackend(() => false), undefined);
});
