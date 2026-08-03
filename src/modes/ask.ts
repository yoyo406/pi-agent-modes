import type { ModeDefinition } from "../types.ts";
import { defaultPolicy } from "../types.ts";

/**
 * `ask` — discussion and analysis only. Strictly read-only.
 */
export const askMode: ModeDefinition = {
	name: "ask",
	aliases: ["chat"],
	label: "Ask",
	description: "Discussion and analysis only. Read-only: no file modifications.",
	instructions: `You are in "ask" mode: discussion and analysis only.

Restrictions:
- You may NOT modify any file. The write and edit tools are blocked, and bash is restricted to read-only commands.
- Answer questions, explain code, analyze behavior and trade-offs.

Behavior:
- If the user asks for a change, explain what the change would involve and suggest switching to a working mode (e.g. "/mode build") instead of attempting it yourself.`,
	defaultPolicy: defaultPolicy({
		allowWriteTools: false,
		bash: "readOnly",
	}),
	defaultEnabled: true,
};
