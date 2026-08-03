import { test } from "node:test";
import assert from "node:assert/strict";
import { ModeRegistry, BUILTIN_MODES } from "../src/modes/registry.ts";
import type { ModeDefinition } from "../src/types.ts";
import { defaultPolicy } from "../src/types.ts";

test("registry resolves built-in modes by canonical name", () => {
	const registry = new ModeRegistry();
	assert.equal(registry.resolve("ask")?.name, "ask");
	assert.equal(registry.resolve("plan")?.name, "plan");
	assert.equal(registry.resolve("build")?.name, "build");
	assert.equal(registry.resolve("review")?.name, "review");
	assert.equal(registry.resolve("debug")?.name, "debug");
	assert.equal(registry.resolve("yolo")?.name, "yolo");
});

test("registry resolves aliases (act -> build, fix -> debug, autopilot -> yolo)", () => {
	const registry = new ModeRegistry();
	assert.equal(registry.resolve("act")?.name, "build");
	assert.equal(registry.resolve("fix")?.name, "debug");
	assert.equal(registry.resolve("autopilot")?.name, "yolo");
	assert.equal(registry.resolve("chat")?.name, "ask");
	assert.equal(registry.resolve("audit")?.name, "review");
	assert.equal(registry.canonicalName("ACT"), "build");
});

test("registry is case-insensitive and trims whitespace", () => {
	const registry = new ModeRegistry();
	assert.equal(registry.resolve("  Plan ")?.name, "plan");
	assert.equal(registry.resolve("YOLO")?.name, "yolo");
});

test("registry returns undefined for unknown names", () => {
	const registry = new ModeRegistry();
	assert.equal(registry.resolve("nope"), undefined);
	assert.equal(registry.resolve(""), undefined);
});

test("registry lists each mode exactly once, in registration order", () => {
	const registry = new ModeRegistry();
	const names = registry.list().map((mode) => mode.name);
	assert.deepEqual(names, ["ask", "plan", "build", "review", "debug", "yolo"]);
});

test("registry rejects duplicate registration and alias collisions", () => {
	const custom: ModeDefinition = {
		name: "custom",
		aliases: ["x"],
		label: "Custom",
		description: "d",
		instructions: "i",
		defaultPolicy: defaultPolicy(),
		defaultEnabled: true,
	};
	const registry = new ModeRegistry([custom]);
	assert.throws(() => registry.register(custom), /already registered/i);
	const clash: ModeDefinition = { ...custom, name: "other", aliases: ["x"] };
	assert.throws(() => registry.register(clash), /alias already in use/i);
});

test("BUILTIN_MODES have unique names and non-empty definitions", () => {
	const names = new Set<string>();
	for (const mode of BUILTIN_MODES) {
		assert.ok(mode.name.length > 0, "mode name required");
		assert.ok(mode.description.length > 0, "description required");
		assert.ok(mode.instructions.length > 0, "instructions required");
		assert.ok(!names.has(mode.name), `duplicate mode ${mode.name}`);
		names.add(mode.name);
	}
	// Read-only modes must not allow writes by default.
	for (const mode of ["ask", "plan", "review"]) {
		const def = BUILTIN_MODES.find((m) => m.name === mode);
		assert.equal(def?.defaultPolicy.allowWriteTools, false, `${mode} must default to read-only`);
		assert.equal(def?.defaultPolicy.bash, "readOnly", `${mode} must default to readOnly bash`);
	}
	// Working modes must allow writes by default.
	for (const mode of ["build", "debug", "yolo"]) {
		const def = BUILTIN_MODES.find((m) => m.name === mode);
		assert.equal(def?.defaultPolicy.allowWriteTools, true, `${mode} must default to write access`);
		assert.equal(def?.defaultPolicy.bash, "allow", `${mode} must default to allowed bash`);
	}
});
