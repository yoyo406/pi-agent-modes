/**
 * pi-agent-modes — switchable workflow modes for the Pi coding agent.
 *
 * Modes: ask, plan, build (alias: act), review, debug, yolo.
 *
 * Enforcement layers (Pi has no native permission system, so everything is
 * implemented here):
 * 1. `tool_call` hook blocks write tools / restricted bash / blocked tools.
 * 2. `pi.setActiveTools()` removes write tools from the model's tool list
 *    while a read-only mode is active (defense in depth), restored on exit.
 * 3. `before_agent_start` injects the mode's instructions into the system
 *    prompt every turn.
 *
 * Persistence: `pi.appendEntry("pi-modes", state)` on every switch, restored
 * on `session_start` from the current branch (fork-aware).
 *
 * Configuration: `~/.pi/agent/modes.config.json` (global) and
 * `.pi/modes.config.json` (project, only when the project is trusted).
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Key, type AutocompleteItem } from "@earendil-works/pi-tui";
import {
	CONFIG_DIR_NAME,
	getAgentDir,
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ExtensionContext,
	type ThemeColor,
} from "@earendil-works/pi-coding-agent";
import type { EffectiveMode, ModesConfig, ThinkingLevel } from "../src/types.ts";
import { ModeRegistry, cycleMode } from "../src/modes/registry.ts";
import {
	CONFIG_FILE_NAME,
	parseModesConfig,
	resolveEffectiveModes,
	pickInitialMode,
	type ConfigValidationIssue,
} from "../src/config.ts";
import { evaluateToolCall, filterActiveTools } from "../src/guard.ts";
import { buildModePromptSection } from "../src/instructions.ts";
import { MODE_STATE_ENTRY_TYPE, buildStateEntry, extractState, nextPrevious } from "../src/state.ts";
import { modeNotificationText, modeStatusText } from "../src/ui.ts";
import {
	type PlanStep,
	extractPlanSteps,
	markCompletedSteps,
	completedCount,
	renderStepLines,
} from "../src/modes/plan-tracker.ts";

/** Keyboard shortcut for "return to previous mode". */
const MODE_BACK_SHORTCUT = Key.ctrlAlt("m");

/** Keyboard shortcut for "cycle to the next mode" (quick switching). */
const MODE_CYCLE_SHORTCUT = Key.alt("m");

/** Widget shown directly above the input bar (TUI only). */
const MODE_WIDGET_KEY = "pi-modes";

/** Widget showing the plan-mode step checklist. */
const PLAN_WIDGET_KEY = "pi-modes-plan";

/** Custom message type used to kick off plan execution after a switch. */
const PLAN_EXECUTE_TYPE = "pi-modes-plan-execute";

/** Tools this extension manages (removed from the active set when restricted). */
const MANAGED_TOOLS = new Set(["edit", "write", "bash"]);

/** Does the mode need the active tool set to be filtered? `blockTools` entries are handled by the tool_call hook, not by list filtering. */
function isRestricting(mode: EffectiveMode): boolean {
	return !mode.policy.allowWriteTools || mode.policy.bash === "deny" || mode.policy.blockUnknownTools;
}

/**
 * Extract concatenated text from an assistant message's content blocks, without
 * importing pi-ai/pi-agent-core types (kept dependency-free). Returns `null` for
 * non-assistant messages or messages with no text content.
 */
function assistantText(message: unknown): string | null {
	if (typeof message !== "object" || message === null) return null;
	const msg = message as { role?: unknown; content?: unknown };
	if (msg.role !== "assistant") return null;
	const content = msg.content;
	if (!Array.isArray(content)) return null;
	const parts: string[] = [];
	for (const block of content) {
		if (
			typeof block === "object" &&
			block !== null &&
			(block as { type?: unknown }).type === "text" &&
			typeof (block as { text?: unknown }).text === "string"
		) {
			parts.push((block as { text: string }).text);
		}
	}
	return parts.length > 0 ? parts.join("\n") : null;
}

export default function (pi: ExtensionAPI): void {
	const registry = new ModeRegistry();

	// ------------------------------------------------------------------ state
	let effective = new Map<string, EffectiveMode>();
	let issues: ConfigValidationIssue[] = [];
	let current: EffectiveMode | undefined;
	let previousMode: string | undefined;
	/** Active tools captured when a restricting mode was entered. */
	let savedTools: string[] | undefined;
	/** The thinking level active before a mode forced its own (to restore on exit). */
	let savedThinkingLevel: ThinkingLevel | undefined;
	/** Whether a mode is currently forcing a thinking level. */
	let thinkingOverridden = false;
	/** Plan steps tracked while in plan mode / execution. */
	let planSteps: PlanStep[] = [];
	/** True once a plan has been detected and execution is under way. */
	let planExecuting = false;

	// ------------------------------------------------------------------ tools
	function applyActiveTools(): void {
		if (!current) return;
		if (!isRestricting(current)) {
			if (savedTools) {
				pi.setActiveTools(savedTools);
				savedTools = undefined;
			}
			return;
		}
		if (savedTools === undefined) savedTools = pi.getActiveTools();
		const customTools = new Set(
			pi.getAllTools()
				.filter((tool) => tool.sourceInfo.source !== "builtin")
				.map((tool) => tool.name),
		);
		pi.setActiveTools(filterActiveTools(pi.getActiveTools(), current.policy, customTools));
	}

	/**
	 * Force the mode's thinking level (if any) via `pi.setThinkingLevel()`.
	 * Saves the user's previous level so it can be restored when leaving.
	 */
	function applyThinkingLevel(): void {
		const level = current?.policy.thinkingLevel;
		if (!level) {
			// Mode does not force a level: restore the saved one, if any.
			if (thinkingOverridden && savedThinkingLevel !== undefined) {
				pi.setThinkingLevel(savedThinkingLevel);
			}
			thinkingOverridden = false;
			savedThinkingLevel = undefined;
			return;
		}
		if (!thinkingOverridden) {
			savedThinkingLevel = pi.getThinkingLevel();
			thinkingOverridden = true;
		}
		pi.setThinkingLevel(level);
	}

	// -------------------------------------------------------------------- UI
	function updateStatus(ctx: ExtensionContext): void {
		ctx.ui.setStatus("pi-modes", current ? modeStatusText(current, ctx.ui.theme) : undefined);
	}

	/** Show the current mode name directly above the input bar. */
	function updateWidget(ctx: ExtensionContext): void {
		if (!ctx.hasUI) return;
		ctx.ui.setWidget(MODE_WIDGET_KEY, current ? [current.name] : undefined);
	}

	/**
	 * Render the plan step checklist above the input bar while a plan is being
	 * tracked, and reflect completion in the footer status. Cleared otherwise.
	 */
	/** Tracked plan is visible while in plan mode or during plan execution. */
	function planWidgetVisible(): boolean {
		return planSteps.length > 0 && (current?.name === "plan" || planExecuting);
	}

	/**
	 * Render the plan step checklist above the input bar while a plan is being
	 * tracked, and reflect completion in the footer status. Cleared otherwise.
	 */
	function updatePlanWidget(ctx: ExtensionContext): void {
		if (!ctx.hasUI) {
			// Footer status is the source of truth in non-TUI modes.
			if (planWidgetVisible()) {
				ctx.ui.setStatus(PLAN_WIDGET_KEY, ctx.ui.theme.fg("accent", `📋 ${completedCount(planSteps)}/${planSteps.length}`));
			} else {
				ctx.ui.setStatus(PLAN_WIDGET_KEY, undefined);
			}
			return;
		}
		if (planWidgetVisible()) {
			ctx.ui.setWidget(PLAN_WIDGET_KEY, renderStepLines(planSteps, (c, t) => ctx.ui.theme.fg(c as ThemeColor, t)));
			ctx.ui.setStatus(PLAN_WIDGET_KEY, ctx.ui.theme.fg("accent", `📋 ${completedCount(planSteps)}/${planSteps.length}`));
		} else {
			ctx.ui.setWidget(PLAN_WIDGET_KEY, undefined);
			ctx.ui.setStatus(PLAN_WIDGET_KEY, undefined);
		}
	}

	// ------------------------------------------------------------ persistence
	function persist(): void {
		if (!current) return;
		pi.appendEntry(MODE_STATE_ENTRY_TYPE, buildStateEntry(current.name, previousMode));
	}

	// -------------------------------------------------------------- switching
	function switchTo(name: string, ctx: ExtensionContext): boolean {
		const resolved = registry.resolve(name);
		if (!resolved) {
			ctx.ui.notify(`Unknown mode "${name}". Available: ${[...effective.keys()].join(", ")}`, "error");
			return false;
		}
		const target = effective.get(resolved.name);
		if (!target) {
			ctx.ui.notify(`Mode "${resolved.name}" is disabled in modes.config.json.`, "error");
			return false;
		}
		if (current?.name === target.name) {
			ctx.ui.notify(`Already in mode "${target.name}".`, "info");
			return true;
		}
		previousMode = nextPrevious(current?.name, target.name);
		current = target;
		applyActiveTools();
		applyThinkingLevel();
		// Entering a non-plan mode clears tracked plan steps, unless we are
		// mid-execution (the Execute flow keeps tracking [DONE:n] in build).
		if (target.name !== "plan" && !planExecuting) {
			planSteps = [];
			planExecuting = false;
		}
		updateStatus(ctx);
		updateWidget(ctx);
		updatePlanWidget(ctx);
		persist();
		ctx.ui.notify(modeNotificationText(target), target.policy.allowWriteTools ? "info" : "warning");
		return true;
	}

	/** Cycle to the next (1) or previous (-1) enabled mode. */
	function cycleTo(ctx: ExtensionContext, direction: 1 | -1): void {
		if (!current) return;
		const next = cycleMode([...effective.keys()], current.name, direction);
		if (!next) {
			ctx.ui.notify("Nothing to cycle: fewer than two enabled modes.", "info");
			return;
		}
		switchTo(next, ctx);
	}

	function switchToPrevious(ctx: ExtensionContext): void {
		if (!previousMode || !current) {
			ctx.ui.notify("No previous mode to return to.", "info");
			return;
		}
		const target = effective.get(previousMode);
		if (!target) {
			ctx.ui.notify(`Previous mode "${previousMode}" is disabled or unknown; nothing to return to.`, "warning");
			previousMode = undefined;
			return;
		}
		// The previous mode becomes current; the old current becomes previous
		// (toggle semantics: ask -> plan -> back -> ask -> back -> plan ...).
		const oldCurrent = current;
		current = target;
		previousMode = oldCurrent.name;
		applyActiveTools();
		applyThinkingLevel();
		if (target.name !== "plan" && !planExecuting) {
			planSteps = [];
			planExecuting = false;
		}
		updateStatus(ctx);
		updateWidget(ctx);
		updatePlanWidget(ctx);
		persist();
		ctx.ui.notify(modeNotificationText(target), target.policy.allowWriteTools ? "info" : "warning");
	}

	function describeCurrent(): string {
		if (!current) return "No mode active.";
		const lines: string[] = [];
		const aliasText = current.aliases.length > 0 ? ` (aliases: ${current.aliases.join(", ")})` : "";
		const levelText = current.policy.thinkingLevel ? ` — thinking: ${current.policy.thinkingLevel}` : "";
		lines.push(
			`Current mode: ${current.name}${current.policy.allowWriteTools ? "" : " (read-only)"}${aliasText}${levelText}${
				previousMode ? ` — previous: ${previousMode}` : ""
			}`,
		);
		lines.push("");
		lines.push("Available modes:");
		for (const mode of effective.values()) {
			const marker = mode.name === current.name ? " * " : "   ";
			const access = mode.policy.allowWriteTools ? "" : " 🔒";
			const aliases = mode.aliases.length > 0 ? ` [${mode.aliases.join(", ")}]` : "";
			lines.push(`${marker}${mode.name.padEnd(8)}${access}${aliases}  ${mode.description}`);
		}
		lines.push("");
		lines.push("Switch: /mode <name|alias>   |   cycle: alt+m   |   back: /mode back or ctrl+alt+m");
		return lines.join("\n");
	}

	// --------------------------------------------------------------- config
	async function loadConfigs(ctx: ExtensionContext): Promise<{ config: ModesConfig; issues: ConfigValidationIssue[] }> {
		const loaded: Array<{ config: ModesConfig; issues: ConfigValidationIssue[] }> = [];
		const sources: Array<{ path: string; include: boolean }> = [
			{ path: join(getAgentDir(), CONFIG_FILE_NAME), include: true },
			{ path: join(ctx.cwd, CONFIG_DIR_NAME, CONFIG_FILE_NAME), include: ctx.isProjectTrusted() },
		];
		for (const source of sources) {
			if (!source.include) continue;
			try {
				const raw = await readFile(source.path, "utf8");
				loaded.push(parseModesConfig(raw, source.path));
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
					loaded.push({
						config: {},
						issues: [{ path: source.path, message: `Failed to read config: ${(error as Error).message}` }],
					});
				}
			}
		}
		// Merge: project overrides global (top-level keys and per-mode keys).
		const merged: ModesConfig = {};
		const allIssues: ConfigValidationIssue[] = [];
		for (const item of loaded) {
			allIssues.push(...item.issues);
			if (item.config.defaultMode !== undefined) merged.defaultMode = item.config.defaultMode;
			for (const [name, override] of Object.entries(item.config.modes ?? {})) {
				merged.modes = merged.modes ?? {};
				merged.modes[name] = { ...merged.modes[name], ...override };
			}
		}
		return { config: merged, issues: allIssues };
	}

	function reportIssues(ctx: ExtensionContext): void {
		for (const issue of issues) {
			ctx.ui.notify(`[modes] Config: ${issue.message}`, "warning");
		}
	}

	// ---------------------------------------------------------------- events
	pi.on("session_start", async (event, ctx) => {
		const loaded = await loadConfigs(ctx);
		effective = resolveEffectiveModes(registry, loaded.config, loaded.issues);
		issues = loaded.issues;

		const cliMode = typeof pi.getFlag("modes") === "string" ? (pi.getFlag("modes") as string) : undefined;
		const persisted = extractState(ctx.sessionManager.getBranch());
		const initial = pickInitialMode(effective, cliMode, persisted?.mode, loaded.config.defaultMode, issues);
		current = initial;
		previousMode = persisted?.previousMode;
		applyActiveTools();
		applyThinkingLevel();
		updateStatus(ctx);
		updateWidget(ctx);
		updatePlanWidget(ctx);
		if (event.reason === "startup" || event.reason === "reload") {
			reportIssues(ctx);
		}
	});

	pi.on("session_shutdown", () => {
		// Session-scoped state is re-established in session_start.
		effective = new Map();
		current = undefined;
		previousMode = undefined;
		savedTools = undefined;
		savedThinkingLevel = undefined;
		thinkingOverridden = false;
		planSteps = [];
		planExecuting = false;
	});

	// Read-only enforcement: blocks write tools and unsafe bash.
	pi.on("tool_call", (event) => {
		if (!current) return;
		const decision = evaluateToolCall({
			modeName: current.name,
			policy: current.policy,
			toolName: event.toolName,
			input: event.input as Record<string, unknown>,
		});
		if (decision.blocked) return { block: true, reason: decision.reason };
	});

	// Per-turn system prompt injection.
	pi.on("before_agent_start", (event) => {
		if (!current) return;
		return { systemPrompt: event.systemPrompt + "\n\n" + buildModePromptSection(current) };
	});

	/**
	 * Plan tracking: when an assistant message in `plan` mode contains a
	 * "Plan:" section, extract its numbered steps, show a progress widget, and
	 * offer to execute (which switches to `build` and injects the plan).
	 * `[DONE:n]` markers mark steps complete during execution.
	 */
	pi.on("message_end", async (event, ctx) => {
		if (!current) return;
		const text = assistantText(event.message);
		if (!text) return;

		// Mark completed steps from [DONE:n] markers (execution phase).
		if (planSteps.length > 0) {
			const newlyDone = markCompletedSteps(text, planSteps);
			if (newlyDone > 0) updatePlanWidget(ctx);
		}

		// Only auto-detect a fresh plan while sitting in `plan` mode and not yet executing.
		if (current.name !== "plan" || planExecuting) return;
		const fresh = extractPlanSteps(text);
		if (fresh.length === 0) return;
		planSteps = fresh;
		updatePlanWidget(ctx);
		ctx.ui.notify(`[modes] Plan detected: ${fresh.length} step(s).`, "info");

		// Offer an interactive transition (TUI only — skip in print/RPC).
		if (!ctx.hasUI) return;
		const choice = await ctx.ui.select("Plan mode — what next?", [
			"Execute the plan (switch to build)",
			"Stay in plan mode",
			"Refine the plan",
		]);
		if (!choice) return;
		if (choice.startsWith("Execute")) {
			const remaining = planSteps.map((s) => `${s.step}. ${s.text}`).join("\n");
			const first = planSteps[0]?.text ?? "the first step";
			planExecuting = true;
			switchTo("build", ctx);
			pi.sendMessage(
				{ customType: PLAN_EXECUTE_TYPE, content: `Execute the plan.\n\nRemaining steps:\n${remaining}\n\nStart with: ${first}.\nAfter completing a step, include a [DONE:n] tag in your response.`, display: true },
				{ triggerTurn: true, deliverAs: "followUp" },
			);
		} else if (choice === "Refine the plan") {
			const refinement = await ctx.ui.editor("Refine the plan:", "");
			if (refinement?.trim()) {
				pi.sendUserMessage(refinement.trim(), { deliverAs: "followUp" });
			}
		}
	});

	// Re-persist the active mode each turn so forked/resumed sessions stay in sync.
	pi.on("turn_start", async () => {
		if (current) persist();
	});

	// -------------------------------------------------------------- commands
	pi.registerCommand("mode", {
		description: "Show or switch the active mode (ask, plan, build, review, debug, yolo)",
		getArgumentCompletions: (prefix: string): AutocompleteItem[] | null => {
			const items: AutocompleteItem[] = [
				{ value: "back", label: "back", description: "Return to the previous mode" },
				...[...effective.values()].flatMap((mode) => {
					const itemsForMode: AutocompleteItem[] = [
						{ value: mode.name, label: mode.name, description: mode.description },
					];
					for (const alias of mode.aliases) {
						itemsForMode.push({
							value: alias,
							label: alias,
							description: `alias of ${mode.name}: ${mode.description}`,
						});
					}
					return itemsForMode;
				}),
			];
			const filtered = items.filter((item) => item.value.startsWith(prefix.toLowerCase()));
			return filtered.length > 0 ? filtered : null;
		},
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const arg = (args ?? "").trim().toLowerCase();
			if (!arg) {
				ctx.ui.notify(describeCurrent(), "info");
				return;
			}
			if (arg === "back") {
				switchToPrevious(ctx);
				return;
			}
			switchTo(arg, ctx);
		},
	});

	pi.registerShortcut(MODE_BACK_SHORTCUT, {
		description: "Return to the previous mode",
		handler: async (ctx: ExtensionContext) => switchToPrevious(ctx),
	});

	pi.registerShortcut(MODE_CYCLE_SHORTCUT, {
		description: "Cycle to the next mode (ask -> plan -> build -> review -> debug -> yolo)",
		handler: async (ctx: ExtensionContext) => cycleTo(ctx, 1),
	});

	pi.registerFlag("modes", {
		description: "Start in the given mode (ask, plan, build, review, debug, yolo)",
		type: "string",
	});
}
