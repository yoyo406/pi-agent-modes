import { test } from "node:test";
import assert from "node:assert/strict";
import {
	parseModesConfig,
	applyOverride,
	resolveEffectiveModes,
	pickInitialMode,
} from "../src/config.ts";
import { ModeRegistry } from "../src/modes/registry.ts";

test("parseModesConfig accepts a valid config", () => {
	const { config, issues } = parseModesConfig(
		JSON.stringify({ defaultMode: "plan", modes: { ask: { enabled: false } } }),
		"test.json",
	);
	assert.equal(issues.length, 0);
	assert.equal(config.defaultMode, "plan");
	assert.equal(config.modes?.ask?.enabled, false);
});

test("parseModesConfig reports invalid JSON instead of throwing", () => {
	const { config, issues } = parseModesConfig("{ not json", "test.json");
	assert.deepEqual(config, {});
	assert.equal(issues.length, 1);
	assert.match(issues[0]!.message, /Invalid JSON/);
});

test("parseModesConfig rejects a non-object root", () => {
	const { issues } = parseModesConfig("[1,2,3]", "test.json");
	assert.equal(issues.length, 1);
	assert.match(issues[0]!.message, /object/);
});

test("parseModesConfig validates field types and drops invalid values", () => {
	const { config, issues } = parseModesConfig(
		JSON.stringify({
			defaultMode: 42,
			modes: {
				ask: { enabled: "yes", bash: "sometimes", blockTools: "edit", instructions: 7 },
				plan: { bash: "deny" },
			},
		}),
		"test.json",
	);
	assert.equal(config.defaultMode, undefined);
	assert.equal(config.modes?.ask?.enabled, undefined);
	assert.equal(config.modes?.ask?.bash, undefined);
	assert.equal(config.modes?.ask?.blockTools, undefined);
	assert.equal(config.modes?.ask?.instructions, undefined);
	assert.equal(config.modes?.plan?.bash, "deny"); // valid value survives
	assert.equal(issues.length, 5);
});

test("applyOverride merges a config override onto a mode definition", () => {
	const registry = new ModeRegistry();
	const ask = registry.resolve("ask")!;
	const effective = applyOverride(ask, {
		enabled: false,
		description: "Custom desc",
		instructions: "Custom instructions",
		extraInstructions: ["Extra line 1"],
		allowWriteTools: true,
		blockTools: ["foo"],
	});
	assert.equal(effective.enabled, false);
	assert.equal(effective.description, "Custom desc");
	assert.equal(effective.instructions, "Custom instructions\n\nExtra line 1");
	assert.equal(effective.policy.allowWriteTools, true);
	assert.deepEqual(effective.policy.blockTools, ["foo"]);
	// Unset fields keep the defaults.
	assert.equal(effective.policy.bash, "readOnly");
});

test("applyOverride accepts a single extra instruction string", () => {
	const registry = new ModeRegistry();
	const effective = applyOverride(registry.resolve("plan")!, {
		extraInstructions: "Prefer the project's existing conventions.",
	});
	assert.match(effective.instructions, /existing conventions/);
});

test("applyOverride with no override keeps defaults", () => {
	const registry = new ModeRegistry();
	const effective = applyOverride(registry.resolve("ask")!, undefined);
	assert.equal(effective.enabled, true);
	assert.equal(effective.policy.allowWriteTools, false);
	assert.equal(effective.policy.bash, "readOnly");
});

test("resolveEffectiveModes excludes disabled modes and reports unknown ones", () => {
	const registry = new ModeRegistry();
	const issues: Array<{ path: string; message: string }> = [];
	const effective = resolveEffectiveModes(
		registry,
		{ modes: { ask: { enabled: false }, ghost: { enabled: true } } },
		issues,
	);
	assert.equal(effective.has("ask"), false);
	assert.equal(effective.has("plan"), true);
	assert.equal(effective.size, 5);
	assert.equal(issues.length, 1);
	assert.match(issues[0]!.message, /ghost/);
});

test("pickInitialMode priority: CLI > persisted > defaultMode > first enabled", () => {
	const registry = new ModeRegistry();
	const effective = resolveEffectiveModes(registry, {});
	const issues: Array<{ path: string; message: string }> = [];

	// CLI wins
	assert.equal(pickInitialMode(effective, "yolo", "ask", undefined, issues)?.name, "yolo");
	// Persisted wins over defaultMode
	assert.equal(pickInitialMode(effective, undefined, "review", "plan", issues)?.name, "review");
	// defaultMode used when nothing else
	assert.equal(pickInitialMode(effective, undefined, undefined, "debug", issues)?.name, "debug");
	// First enabled mode as final fallback
	assert.equal(pickInitialMode(effective, undefined, undefined, undefined, issues)?.name, "ask");
	assert.equal(issues.length, 0);
});

test("pickInitialMode resolves aliases when a canonicalizer is provided", () => {
	const registry = new ModeRegistry();
	const effective = resolveEffectiveModes(registry, {});
	const issues: Array<{ path: string; message: string }> = [];
	assert.equal(
		pickInitialMode(effective, "act", undefined, undefined, issues, (name) => registry.canonicalName(name))?.name,
		"build",
	);
	assert.equal(issues.length, 0);
});

test("pickInitialMode skips invalid candidates and reports them", () => {
	const registry = new ModeRegistry();
	const effective = resolveEffectiveModes(registry, { modes: { ask: { enabled: false } } });
	const issues: Array<{ path: string; message: string }> = [];
	const picked = pickInitialMode(effective, "ghost", "ask", "plan", issues);
	// ghost (unknown) and ask (disabled) skipped; defaultMode plan wins.
	assert.equal(picked?.name, "plan");
	assert.equal(issues.length, 2);
});

test("config can disable every mode; pickInitialMode returns undefined", () => {
	const registry = new ModeRegistry();
	const effective = resolveEffectiveModes(
		registry,
		{ modes: Object.fromEntries(registry.list().map((m) => [m.name, { enabled: false }])) },
	);
	const issues: Array<{ path: string; message: string }> = [];
	assert.equal(effective.size, 0);
	assert.equal(pickInitialMode(effective, undefined, undefined, undefined, issues), undefined);
});

test("applyOverride accepts a thinkingLevel override", () => {
	const registry = new ModeRegistry();
	const ask = registry.resolve("ask")!;
	// Built-in ask has no forced level; override adds one.
	const effective = applyOverride(ask, { thinkingLevel: "high" });
	assert.equal(effective.policy.thinkingLevel, "high");
});

test("applyOverride clears a mode's thinkingLevel with null", () => {
	const registry = new ModeRegistry();
	const plan = registry.resolve("plan")!; // built-in: thinkingLevel "high"
	assert.equal(plan.defaultPolicy.thinkingLevel, "high");
	const effective = applyOverride(plan, { thinkingLevel: null });
	assert.equal(effective.policy.thinkingLevel, undefined);
});

test("applyOverride with no override keeps the built-in thinkingLevel", () => {
	const registry = new ModeRegistry();
	const plan = applyOverride(registry.resolve("plan")!, undefined);
	assert.equal(plan.policy.thinkingLevel, "high");
	const build = applyOverride(registry.resolve("build")!, undefined);
	assert.equal(build.policy.thinkingLevel, undefined);
});

test("parseModesConfig validates thinkingLevel and drops invalid values", () => {
	const { config, issues } = parseModesConfig(
		JSON.stringify({
			modes: {
				ask: { thinkingLevel: "high" },
				plan: { thinkingLevel: "sometimes" },
				build: { thinkingLevel: null },
			},
		}),
		"test.json",
	);
	assert.equal(config.modes?.ask?.thinkingLevel, "high");
	assert.equal(config.modes?.plan?.thinkingLevel, undefined); // invalid, dropped
	assert.equal(config.modes?.build?.thinkingLevel, null); // null is valid (clear)
	assert.equal(issues.length, 1);
	assert.match(issues[0]!.message, /thinkingLevel/);
});
