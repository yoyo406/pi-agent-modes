import type { ModePolicy } from "./types.ts";

/**
 * Pure tool-call guard: decides whether a tool call is blocked under a mode's
 * policy. Pi has no native permission system, so this is the enforcement
 * layer for read-only modes. Kept dependency-free for unit testing.
 */

/** Built-in tools that mutate the filesystem. */
export const WRITE_TOOLS = ["edit", "write"] as const;

/**
 * Built-in tools that are read-only by construction. Used to decide whether a
 * tool is "known" when `blockUnknownTools` is enabled.
 */
export const READONLY_BUILTIN_TOOLS = ["read", "grep", "find", "ls"] as const;

export const BUILTIN_TOOLS: readonly string[] = [
	...READONLY_BUILTIN_TOOLS,
	"bash",
	...WRITE_TOOLS,
];

export interface GuardRequest {
	modeName: string;
	policy: ModePolicy;
	toolName: string;
	/** Raw tool arguments (used for the bash command). */
	input: Record<string, unknown>;
}

export interface GuardDecision {
	blocked: boolean;
	reason?: string;
}

/** Build the block reason shown to the model. */
export function blockReason(modeName: string, detail: string): string {
	return `[modes] Blocked by mode "${modeName}": ${detail} Switch modes with /mode if this tool is required.`;
}

/**
 * Evaluate a tool call against a mode policy.
 * Priority: explicit allowTools → explicit blockTools → write tools → bash →
 * unknown tools.
 */
export function evaluateToolCall(request: GuardRequest): GuardDecision {
	const { modeName, policy, toolName, input } = request;

	if (policy.allowTools.includes(toolName)) return { blocked: false };

	if (policy.blockTools.includes(toolName)) {
		return { blocked: true, reason: blockReason(modeName, `tool "${toolName}" is blocked by this mode's configuration.`) };
	}

	// Built-in file mutation tools.
	if ((WRITE_TOOLS as readonly string[]).includes(toolName)) {
		if (!policy.allowWriteTools) {
			return { blocked: true, reason: blockReason(modeName, `"${toolName}" modifies files and this mode is read-only.`) };
		}
		return { blocked: false };
	}

	// Bash: deny everything, or allowlist read-only commands.
	if (toolName === "bash") {
		if (policy.bash === "deny") {
			return { blocked: true, reason: blockReason(modeName, "bash is disabled in this mode.") };
		}
		if (policy.bash === "readOnly") {
			const command = typeof input.command === "string" ? input.command : "";
			if (!isSafeBashCommand(command)) {
				return {
					blocked: true,
					reason: blockReason(
						modeName,
						`bash is restricted to read-only commands in this mode.\nBlocked command: ${command || "(empty)"}`,
					),
				};
			}
		}
		return { blocked: false };
	}

	// Unknown (custom) tools: only blocked when the policy demands strictness.
	if (policy.blockUnknownTools && !(READONLY_BUILTIN_TOOLS as readonly string[]).includes(toolName)) {
		return {
			blocked: true,
			reason: blockReason(
				modeName,
				`unknown tool "${toolName}" is blocked because blockUnknownTools is enabled. Add it to allowTools in modes.config.json to permit it.`,
			),
		};
	}

	return { blocked: false };
}

/**
 * Compute the active tool set for a mode (defense-in-depth layer 1).
 *
 * Only the built-in mutating tools (`edit`, `write`, `bash` with deny policy)
 * are removed from the model's tool list. `blockTools` entries and unknown
 * custom tools are deliberately LEFT in the list: the `tool_call` hook then
 * intercepts them with an explanatory reason, so the model learns why the
 * call was blocked instead of silently lacking the tool.
 */
export function filterActiveTools(
	active: readonly string[],
	policy: ModePolicy,
	customTools: ReadonlySet<string>,
): string[] {
	return active.filter((name) => {
		if (policy.allowTools.includes(name)) return true;
		if (name === "edit" || name === "write") return policy.allowWriteTools;
		if (name === "bash") return policy.bash !== "deny";
		if (policy.blockUnknownTools && customTools.has(name)) return false;
		return true;
	});
}

/**
 * Heuristic: is a bash command safe to run in a read-only mode?
 * A command is safe when it matches the read-only allowlist AND does not
 * contain destructive patterns (writes, installs, process/system control).
 */
export function isSafeBashCommand(command: string): boolean {
	if (!command.trim()) return false;
	const destructive = DESTRUCTIVE_PATTERNS.some((pattern) => pattern.test(command));
	if (destructive) return false;
	return SAFE_PATTERNS.some((pattern) => pattern.test(command));
}

// ---------------------------------------------------------------------------
// Command heuristics. The allowlist requires the command to START with a
// read-only command; the denylist catches mutation regardless of position
// (e.g. `cat a > b` is caught by the redirect pattern).
// ---------------------------------------------------------------------------

const SAFE_PATTERNS: RegExp[] = [
	/^\s*(cat|head|tail|less|more|zcat|zgrep|zless|gzcat)\b/,
	/^\s*(grep|rg|ripgrep|egrep|fgrep)\b/,
	/^\s*(find|fd)\b/,
	/^\s*(ls|dir|eza|exa)\b/,
	/^\s*(pwd|realpath|readlink)\b/,
	/^\s*(echo|printf)\b/,
	/^\s*(wc|sort|uniq|cut|paste|comm|diff|cmp)\b/,
	/^\s*(file|stat|du|df|tree)\b/,
	/^\s*(which|whereis|type|command\s+-v)\b/,
	/^\s*(env|printenv|export)\b/,
	/^\s*(uname|whoami|id|hostname|date|cal|uptime)\b/,
	/^\s*(ps|top|htop|free|vmstat|iostat|ss|netstat|lsof)\b/,
	/^\s*(git\s+(status|log|diff|show|branch|remote|config|ls-files|ls-tree|rev-parse|describe|tag\s+-l))\b/,
	/^\s*(git\s+ls-remote)\b/,
	/^\s*(npm\s+(list|ls|view|info|search|outdated|audit))\b/,
	/^\s*(yarn\s+(list|info|why|audit))\b/,
	/^\s*(pnpm\s+(list|ls|view|info|search|outdated|audit))\b/,
	/^\s*(python3?|node|deno|bun)\s+--version\b/,
	/^\s*(curl|wget)\b/,
	/^\s*(jq|yq)\b/,
	/^\s*(awk|sed\s+-n|perl\s+-ne)\b/,
	/^\s*(bat|batcat)\b/,
];

const DESTRUCTIVE_PATTERNS: RegExp[] = [
	/\b(rm|rmdir|unlink|trash)\b/,
	/\b(mv|cp|ln|install|dd|shred|truncate)\b/,
	/\b(mkdir|touch|mktemp)\b/,
	/\b(chmod|chown|chgrp|setfacl|setfattr)\b/,
	/\b(tee|split|csplit|yes|mkfifo|mknod)\b/,
	/(^|[^<])(>|>>)(?!=)/, // output redirection
	/\b(npm|yarn|pnpm|bun|npx|deno)\s+(install|add|remove|uninstall|update|ci|link|publish|run|exec|dlx|test)\b/,
	/\b(pip|pip3|uv)\s+(install|uninstall|download|sync|add|remove|run)\b/,
	/\b(cargo|go)\s+(build|run|test|install|add|remove|publish|fmt|vet|clean)\b/,
	/\b(apt|apt-get|aptitude|dnf|yum|pacman|brew|port)\s+(install|remove|purge|update|upgrade|autoremove|clean)\b/,
	/\b(git)\s+(add|commit|push|pull|merge|rebase|reset|checkout|switch|restore|stash|cherry-pick|revert|tag|init|clone|clean|gc|prune|fetch)\b/,
	/\b(sudo|su|doas)\b/,
	/\b(kill|pkill|killall|nice|renice)\b/,
	/\b(reboot|shutdown|halt|poweroff|systemctl|service|initctl|rc-service)\b/,
	/\b(vim?|nano|emacs|code|subl|micro|nvim)\b/,
	/\b(docker|podman|nerdctl|kubectl|helm)\b/,
	/\b(format|mkfs|fdisk|parted|mount|umount)\b/,
];
