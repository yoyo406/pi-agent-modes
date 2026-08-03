import { test } from "node:test";
import assert from "node:assert/strict";
import {
	extractPlanSteps,
	extractDoneMarkers,
	markCompletedSteps,
	completedCount,
	renderStepLines,
	cleanStepText,
	type PlanStep,
} from "../src/modes/plan-tracker.ts";

test("extractPlanSteps returns [] when no Plan: header", () => {
	assert.deepEqual(extractPlanSteps("Some text without a plan header."), []);
	assert.deepEqual(extractPlanSteps(""), []);
});

test("extractPlanSteps extracts numbered steps after a Plan: header", () => {
	const msg = `Here is the plan.

Plan:
1. Update the config loader to accept the new field
2. Add a regression test for the default value
3. Run the type checker

Validation: run npm test.`;
	const steps = extractPlanSteps(msg);
	assert.equal(steps.length, 3);
	assert.equal(steps[0]?.step, 1);
	assert.equal(steps[0]?.text, "Update the config loader to accept the new field");
	assert.equal(steps[1]?.step, 2);
	assert.equal(steps[1]?.completed, false);
	// Numbering is re-based (1..n) regardless of the model's numbers.
	assert.equal(steps[2]?.step, 3);
});

test("extractPlanSteps ignores code blocks, sub-bullets and short fragments", () => {
	const msg = `Plan:
1. Real step one is here
   \`code-thing\`
- a sub bullet
2. ok`;
	const steps = extractPlanSteps(msg);
	assert.equal(steps.length, 1);
	assert.equal(steps[0]?.step, 1);
	assert.equal(steps[0]?.text, "Real step one is here");
});

test("extractPlanSteps accepts **Plan:** and *Plan:* header variants", () => {
	for (const header of ["Plan:\n", "**Plan:**\n", "*Plan:*\n"]) {
		const steps = extractPlanSteps(`${header}1. Do the thing properly now`);
		assert.equal(steps.length, 1, `header ${header} should parse`);
	}
});

test("extractDoneMarkers parses [DONE:n] markers case-insensitively", () => {
	assert.deepEqual(extractDoneMarkers("finished [DONE:1] and [done:3]"), [1, 3]);
	assert.deepEqual(extractDoneMarkers("nothing here"), []);
	assert.deepEqual(extractDoneMarkers("[DONE:7] [DONE:7]"), [7, 7]);
});

test("markCompletedSteps marks items and returns newly-completed count", () => {
	const steps: PlanStep[] = [
		{ step: 1, text: "a", completed: false },
		{ step: 2, text: "b", completed: false },
	];
	const n = markCompletedSteps("[DONE:1] [DONE:1] [DONE:2]", steps);
	assert.equal(n, 2);
	assert.equal(steps[0]?.completed, true);
	assert.equal(steps[1]?.completed, true);
	// Re-marking already-complete steps does not inflate the count.
	assert.equal(markCompletedSteps("[DONE:1]", steps), 0);
});

test("markCompletedSteps ignores markers for unknown step numbers", () => {
	const steps: PlanStep[] = [{ step: 1, text: "a", completed: false }];
	assert.equal(markCompletedSteps("[DONE:9]", steps), 0);
	assert.equal(steps[0]?.completed, false);
});

test("completedCount counts completed steps", () => {
	const steps: PlanStep[] = [
		{ step: 1, text: "a", completed: true },
		{ step: 2, text: "b", completed: false },
		{ step: 3, text: "c", completed: true },
	];
	assert.equal(completedCount(steps), 2);
	assert.equal(completedCount([]), 0);
});

test("cleanStepText strips emphasis, inline code and normalizes length", () => {
	assert.equal(cleanStepText("**Update** the `config` loader"), "Update the config loader");
	assert.equal(cleanStepText(""), "");
	assert.equal(cleanStepText("a".repeat(60)).length, 50);
});

test("renderStepLines renders ☐ for pending and ☑ for completed", () => {
	const fg = (color: string, text: string) => `${color}:${text}`;
	const steps: PlanStep[] = [
		{ step: 1, text: "first", completed: false },
		{ step: 2, text: "second", completed: true },
	];
	const lines = renderStepLines(steps, fg);
	assert.equal(lines.length, 2);
	assert.match(lines[0]!, /muted:☐/);
	assert.match(lines[0]!, /first/);
	assert.match(lines[1]!, /success:☑/);
	assert.match(lines[1]!, /muted:second/);
});
