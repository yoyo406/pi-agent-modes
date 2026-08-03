import { test } from "node:test";
import assert from "node:assert/strict";
import { buildModePromptSection, modeHeader, policySummary } from "../src/instructions.ts";
import { applyOverride } from "../src/config.ts";
import { ModeRegistry } from "../src/modes/registry.ts";

const registry = new ModeRegistry();

test("each built-in mode's instructions mention its key workflow", () => {
	const expectations: Record<string, RegExp[]> = {
		ask: [/read-only/i, /may NOT modify/i],
		plan: [/Plan:/i, /Validation/i, /may NOT modify/i],
		build: [/implement/i, /tests/i],
		review: [/Critical issues/i, /Security/i, /may NOT modify/i],
		debug: [/Reproduce/i, /root cause/i, /Regression/i],
		yolo: [/autonomous/i, /minimal confirmations/i],
	};
	for (const [name, patterns] of Object.entries(expectations)) {
		const mode = applyOverride(registry.resolve(name)!, undefined);
		for (const pattern of patterns) {
			assert.match(mode.instructions, pattern, `${name} instructions should match ${pattern}`);
		}
	}
});

test("modeHeader marks read-only modes", () => {
	const ask = applyOverride(registry.resolve("ask")!, undefined);
	assert.match(modeHeader(ask), /\[ACTIVE MODE: ASK 🔒 read-only\]/);
	const build = applyOverride(registry.resolve("build")!, undefined);
	assert.match(modeHeader(build), /\[ACTIVE MODE: BUILD\]/);
});

test("policySummary describes restrictions", () => {
	const ask = applyOverride(registry.resolve("ask")!, undefined);
	assert.match(policySummary(ask), /write\/edit tools blocked/);
	assert.match(policySummary(ask), /bash restricted/);
	const build = applyOverride(registry.resolve("build")!, undefined);
	assert.equal(policySummary(build), "full tool access");
	const deny = applyOverride(registry.resolve("plan")!, {
		bash: "deny",
		blockTools: ["foo"],
		blockUnknownTools: true,
	});
	assert.match(policySummary(deny), /bash disabled/);
	assert.match(policySummary(deny), /"foo" blocked/);
	assert.match(policySummary(deny), /unknown tools blocked/);
});

test("buildModePromptSection contains the header, policy and instructions", () => {
	const plan = applyOverride(registry.resolve("plan")!, undefined);
	const section = buildModePromptSection(plan);
	assert.match(section, /ACTIVE MODE: PLAN/);
	assert.match(section, /Tool policy:/);
	assert.match(section, /Files to modify/);
});

test("custom instructions from config replace the defaults in the section", () => {
	const plan = applyOverride(registry.resolve("plan")!, {
		instructions: "Custom plan instructions.",
	});
	const section = buildModePromptSection(plan);
	assert.match(section, /Custom plan instructions/);
	assert.doesNotMatch(section, /Files to modify/);
});
