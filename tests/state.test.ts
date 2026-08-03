import { test } from "node:test";
import assert from "node:assert/strict";
import { buildStateEntry, extractState, nextPrevious, MODE_STATE_ENTRY_TYPE } from "../src/state.ts";

function entry(type: string, customType: string | undefined, data: unknown) {
	return { type, customType, data };
}

test("buildStateEntry stores mode, previous mode and timestamp", () => {
	const state = buildStateEntry("plan", "ask", 1234);
	assert.deepEqual(state, { version: 2, mode: "plan", previousMode: "ask", changedAt: 1234 });
});

test("extractState returns the last pi-modes entry on the branch", () => {
	const entries = [
		entry("message", undefined, undefined),
		entry("custom", MODE_STATE_ENTRY_TYPE, { mode: "ask", changedAt: 1 }),
		entry("custom", "other-type", { mode: "x" }),
		entry("custom", MODE_STATE_ENTRY_TYPE, { mode: "plan", previousMode: "ask", changedAt: 2 }),
	];
	assert.deepEqual(extractState(entries), { version: 2, mode: "plan", previousMode: "ask", changedAt: 2 });
});

test("extractState ignores malformed entries", () => {
	const entries = [
		entry("custom", MODE_STATE_ENTRY_TYPE, { mode: 42 }),
		entry("custom", MODE_STATE_ENTRY_TYPE, "not an object"),
		entry("custom", MODE_STATE_ENTRY_TYPE, null),
		entry("custom", MODE_STATE_ENTRY_TYPE, undefined),
	];
	assert.equal(extractState(entries), undefined);
});

test("extractState returns undefined on an empty branch", () => {
	assert.equal(extractState([]), undefined);
});

test("extractState tolerates entries missing optional fields", () => {
	const entries = [
		{ type: "custom", customType: MODE_STATE_ENTRY_TYPE, data: { mode: "yolo" } },
	];
	const state = extractState(entries);
	assert.deepEqual(state, { version: 2, mode: "yolo", previousMode: undefined, changedAt: 0 });
});

test("nextPrevious tracks the previous mode for toggle semantics", () => {
	assert.equal(nextPrevious(undefined, "ask"), undefined);
	assert.equal(nextPrevious("ask", "plan"), "ask");
	// Switching to the same mode keeps no history.
	assert.equal(nextPrevious("ask", "ask"), undefined);
	// A chain ask -> plan -> build leaves build with previous=plan.
	assert.equal(nextPrevious("plan", "build"), "plan");
});

test("buildStateEntry persists plan progress", () => {
	const state = buildStateEntry(
		"build",
		"plan",
		[
			{ step: 1, text: "Update code", completed: true },
			{ step: 2, text: "Run tests", completed: false },
		],
		true,
		"# Plan\n\n1. Implement",
		1234,
	);
	assert.deepEqual(state, {
		version: 2,
		mode: "build",
		previousMode: "plan",
		changedAt: 1234,
		planSteps: [
			{ step: 1, text: "Update code", completed: true },
			{ step: 2, text: "Run tests", completed: false },
		],
		planExecuting: true,
		planMarkdown: "# Plan\n\n1. Implement",
	});
});

test("extractState restores valid plan progress and ignores invalid steps", () => {
	const entries = [
		{
			type: "custom",
			customType: MODE_STATE_ENTRY_TYPE,
			data: {
				version: 2,
				mode: "build",
				planExecuting: true,
				planSteps: [
					{ step: 1, text: "Implement", completed: false },
					{ step: "bad", text: "Ignore", completed: false },
				],
			},
		},
	];
	assert.deepEqual(extractState(entries), {
		version: 2,
		mode: "build",
		previousMode: undefined,
		changedAt: 0,
		planSteps: [{ step: 1, text: "Implement", completed: false }],
		planExecuting: true,
	});
});

test("extractState normalizes previousMode when invalid", () => {
	const entries = [
		{ type: "custom", customType: MODE_STATE_ENTRY_TYPE, data: { mode: "plan", previousMode: 7, changedAt: "x" } },
	];
	const state = extractState(entries);
	assert.equal(state?.mode, "plan");
	assert.equal(state?.previousMode, undefined);
	assert.equal(state?.changedAt, 0);
});
