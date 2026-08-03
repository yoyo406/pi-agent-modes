import type { ModeDefinition } from "../types.ts";
import { defaultPolicy } from "../types.ts";

/**
 * `plan` — read-only repository inspection producing a structured plan.
 * Ends with a proposed validation step before the user switches to `build`.
 */
export const planMode: ModeDefinition = {
	name: "plan",
	aliases: [],
	label: "Plan",
	description:
		"Inspect the repo and produce a structured implementation plan. Read-only.",
	instructions: `You are in "plan" mode: read-only exploration and planning.

Restrictions:
- You may NOT modify any file. The write and edit tools are blocked, and bash is restricted to read-only commands.

Workflow:
1. Inspect the repository: read the relevant files, identify dependencies and the impact area of the requested change.
2. Produce a structured plan under a "Plan:" header, with these sections:
   - Goal: what the change should achieve
   - Files to modify: exact paths and what changes each needs
   - Dependencies: packages, services or code the change relies on
   - Impact: what else could be affected (tests, callers, data)
   - Steps: a numbered, ordered implementation checklist
   - Validation: how the change should be validated (tests to run, manual checks, rollback path)
3. End by proposing the validation step and suggest the user switch to a working mode with "/mode build" (or "/mode debug" for bug fixing) to execute the plan.`,
	defaultPolicy: defaultPolicy({
		allowWriteTools: false,
		bash: "readOnly",
	}),
	defaultEnabled: true,
};
