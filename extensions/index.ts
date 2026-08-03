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
import type { AutocompleteItem, KeyId } from "@earendil-works/pi-tui";
import {
	CONFIG_DIR_NAME,
	getAgentDir,
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { EffectiveMode, ModesConfig } from "../src/types.ts";
import { ModeRegistry } from "../src/modes/registry.ts";
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

/** Keyboard shortcut for "return to previous mode". */
const MODE_BACK_SHORTCUT = "ctrl+alt+m" as KeyId;

/** Tools this extension manages (removed from the active set when restricted). */
const MANAGED_TOOLS = new Set(["edit", "write", "bash"]);

/** Does the mode need the active tool set to be filtered? `blockTools` entries are handled by the tool_call hook, not by list filtering. */
function isRestricting(mode: EffectiveMode): boolean {
	return !mode.policy.allowWriteTools || mode.policy.bash === "deny" || mode.policy.blockUnknownTools;
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

	// -------------------------------------------------------------------- UI
	function updateStatus(ctx: ExtensionContext): void {
		ctx.ui.setStatus("pi-modes", current ? modeStatusText(current, ctx.ui.theme) : undefined);
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
		updateStatus(ctx);
		persist();
		ctx.ui.notify(modeNotificationText(target), target.policy.allowWriteTools ? "info" : "warning");
		return true;
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
		updateStatus(ctx);
		persist();
		ctx.ui.notify(modeNotificationText(target), target.policy.allowWriteTools ? "info" : "warning");
	}

	function describeCurrent(): string {
		if (!current) return "No mode active.";
		const lines: string[] = [];
		lines.push(
			`Current mode: ${current.name}${current.policy.allowWriteTools ? "" : " (read-only)"}${
				previousMode ? ` — previous: ${previousMode}` : ""
			}`,
		);
		lines.push("");
		lines.push("Available modes:");
		for (const mode of effective.values()) {
			const marker = mode.name === current.name ? " *" : "  ";
			const access = mode.policy.allowWriteTools ? "" : " 🔒";
			lines.push(`  ${marker} ${mode.name.padEnd(8)}${access} ${mode.description}`);
		}
		lines.push("");
		lines.push("Use /mode <name> to switch, /mode back to return to the previous mode.");
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
		updateStatus(ctx);
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

	// -------------------------------------------------------------- commands
	pi.registerCommand("mode", {
		description: "Show or switch the active mode (ask, plan, build, review, debug, yolo)",
		getArgumentCompletions: (prefix: string): AutocompleteItem[] | null => {
			const items: AutocompleteItem[] = [
				{ value: "back", label: "back", description: "Return to the previous mode" },
				...[...effective.values()].map((mode) => ({
					value: mode.name,
					label: mode.name,
					description: mode.description,
				})),
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

	pi.registerFlag("modes", {
		description: "Start in the given mode (ask, plan, build, review, debug, yolo)",
		type: "string",
	});
}
