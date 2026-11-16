import assert from "node:assert/strict";
import test from "node:test";
import { evaluateBashGuardrail } from "../src/guardrails-core.ts";

test("evaluateBashGuardrail blocks destructive commands and prompts on git push", () => {
	assert.equal(evaluateBashGuardrail("gh pr merge 12 --squash").action, "deny");
	assert.equal(evaluateBashGuardrail("git reset --hard HEAD~1").action, "deny");
	assert.equal(evaluateBashGuardrail("git clean -fdx").action, "deny");
	assert.equal(evaluateBashGuardrail("git push origin dev").action, "confirm");
	assert.equal(evaluateBashGuardrail("git status --short").action, "allow");
});
