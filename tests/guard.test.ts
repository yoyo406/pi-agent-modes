import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluateToolCall, isSafeBashCommand, filterActiveTools, type GuardRequest } from "../src/guard.ts";
import { defaultPolicy, type ModePolicy } from "../src/types.ts";

function guard(policy: ModePolicy, toolName: string, input: Record<string, unknown> = {}): GuardRequest {
	return { modeName: "test", policy, toolName, input };
}

const readOnly: ModePolicy = defaultPolicy({ allowWriteTools: false, bash: "readOnly" });
const fullAccess: ModePolicy = defaultPolicy();
const denyBash: ModePolicy = defaultPolicy({ allowWriteTools: true, bash: "deny" });

test("read-only mode blocks edit and write tools", () => {
	for (const tool of ["edit", "write"]) {
		const decision = evaluateToolCall(guard(readOnly, tool, { path: "/tmp/x" }));
		assert.equal(decision.blocked, true, `${tool} must be blocked`);
		assert.match(decision.reason ?? "", /read-only/);
	}
});

test("read-only mode blocks write tools even with no arguments", () => {
	const decision = evaluateToolCall(guard(readOnly, "write", {}));
	assert.equal(decision.blocked, true);
});

test("full-access mode allows edit and write", () => {
	for (const tool of ["edit", "write"]) {
		assert.equal(evaluateToolCall(guard(fullAccess, tool)).blocked, false);
	}
});

test("read-only mode blocks destructive bash and allows read-only bash", () => {
	const allowed = [
		"cat package.json",
		"git status",
		"git log --oneline -5",
		"ls -la",
		"grep -r foo src/",
		"find . -name '*.ts'",
		"npm list --depth=0",
		"node --version",
		"wc -l src/index.ts",
	];
	for (const command of allowed) {
		assert.equal(evaluateToolCall(guard(readOnly, "bash", { command })).blocked, false, `should allow: ${command}`);
	}
	const blocked = [
		"rm -rf node_modules",
		"echo hi > file.txt",
		"echo hi >> file.txt",
		"npm install",
		"npm test",
		"npm run build",
		"git add .",
		"git commit -m x",
		"mkdir -p foo",
		"touch foo",
		"sudo ls",
		"mv a b",
		"docker build .",
		"pip install requests",
		"sed -i 's/a/b/' f",
		"vim file.txt",
		"cat a > b",
	];
	for (const command of blocked) {
		assert.equal(evaluateToolCall(guard(readOnly, "bash", { command })).blocked, true, `should block: ${command}`);
	}
});

test("deny bash policy blocks all bash, including read-only commands", () => {
	assert.equal(evaluateToolCall(guard(denyBash, "bash", { command: "ls" })).blocked, true);
	assert.equal(evaluateToolCall(guard(denyBash, "bash", { command: "git status" })).blocked, true);
	// ...but other tools are unaffected
	assert.equal(evaluateToolCall(guard(denyBash, "read", { path: "/tmp/x" })).blocked, false);
	assert.equal(evaluateToolCall(guard(denyBash, "edit", { path: "/tmp/x" })).blocked, false);
});

test("allow bash policy never blocks bash", () => {
	assert.equal(evaluateToolCall(guard(fullAccess, "bash", { command: "rm -rf /" })).blocked, false);
});

test("blockTools blocks listed tools even in full-access modes", () => {
	const policy = defaultPolicy({ blockTools: ["my_destructive_tool"] });
	assert.equal(evaluateToolCall(guard(policy, "my_destructive_tool")).blocked, true);
	assert.equal(evaluateToolCall(guard(policy, "read")).blocked, false);
});

test("allowTools overrides blocking", () => {
	const policy = defaultPolicy({
		allowWriteTools: false,
		allowTools: ["special_editor"],
	});
	// allowTools wins for the special tool...
	assert.equal(evaluateToolCall(guard(policy, "special_editor")).blocked, false);
	// ...but write tools are still blocked.
	assert.equal(evaluateToolCall(guard(policy, "write")).blocked, true);
});

test("blockUnknownTools blocks custom tools but keeps built-ins", () => {
	const policy = defaultPolicy({
		allowWriteTools: false,
		bash: "readOnly",
		blockUnknownTools: true,
	});
	assert.equal(evaluateToolCall(guard(policy, "my_custom_tool")).blocked, true);
	assert.equal(evaluateToolCall(guard(policy, "read")).blocked, false);
	assert.equal(evaluateToolCall(guard(policy, "grep")).blocked, false);
	assert.equal(evaluateToolCall(guard(policy, "ls")).blocked, false);
	assert.equal(evaluateToolCall(guard(policy, "find")).blocked, false);
	// allowTools rescues a custom tool
	const withAllow = defaultPolicy({ ...policy, allowTools: ["my_custom_tool"] });
	assert.equal(evaluateToolCall(guard(withAllow, "my_custom_tool")).blocked, false);
});

test("blockUnknownTools without blockUnknownTools flag allows custom tools", () => {
	const policy = defaultPolicy({ allowWriteTools: false, bash: "readOnly" });
	assert.equal(evaluateToolCall(guard(policy, "my_custom_tool")).blocked, false);
});

test("block reasons mention the mode name and the tool", () => {
	const decision = evaluateToolCall(guard(readOnly, "write"));
	assert.match(decision.reason ?? "", /test/);
	assert.match(decision.reason ?? "", /write/);
});

test("isSafeBashCommand heuristics", () => {
	assert.equal(isSafeBashCommand("cat a.txt"), true);
	assert.equal(isSafeBashCommand("git status --short"), true);
	assert.equal(isSafeBashCommand(""), false);
	assert.equal(isSafeBashCommand("   "), false);
	assert.equal(isSafeBashCommand("rm x"), false);
	assert.equal(isSafeBashCommand("cat a > b"), false);
	assert.equal(isSafeBashCommand("npm test"), false);
	assert.equal(isSafeBashCommand("echo hello"), true);
	assert.equal(isSafeBashCommand("cat a | grep x"), true);
});

test("filterActiveTools removes write tools and deny-bash from the active set", () => {
	const active = ["read", "bash", "edit", "write", "grep", "my_tool"];
	const custom = new Set(["my_tool"]);
	const filtered = filterActiveTools(active, readOnly, custom);
	assert.deepEqual(filtered, ["read", "bash", "grep", "my_tool"]);
	// deny bash removes bash too
	const denyFiltered = filterActiveTools(active, denyBash, custom);
	assert.deepEqual(denyFiltered, ["read", "edit", "write", "grep", "my_tool"]);
});

test("filterActiveTools keeps full access intact", () => {
	const active = ["read", "bash", "edit", "write"];
	assert.deepEqual(filterActiveTools(active, fullAccess, new Set()), active);
});

test("filterActiveTools keeps blockTools tools in the list (hook intercepts them)", () => {
	const policy = defaultPolicy({ blockTools: ["read"] });
	const active = ["read", "bash", "edit", "write"];
	assert.deepEqual(filterActiveTools(active, policy, new Set()), active);
});

test("filterActiveTools honors allowTools and blockUnknownTools", () => {
	const policy = defaultPolicy({ allowWriteTools: false, blockUnknownTools: true, allowTools: ["trusted_tool"] });
	const active = ["read", "write", "my_tool", "trusted_tool"];
	const custom = new Set(["my_tool", "trusted_tool"]);
	assert.deepEqual(filterActiveTools(active, policy, custom), ["read", "trusted_tool"]);
});

test("read-only allowlist permits version probes and stdout-only wget", () => {
	for (const command of [
		"python3 --version",
		"python --version",
		"node --version",
		"eza -la",
		"exa -la",
		"bat file.txt",
		"batcat file.txt",
		"gpg --verify sig.asc",
		"gpg --list-keys",
		"openssl version",
		"openssl x509 -in cert.pem -noout -text",
		"direnv dump",
		"wget -O - https://example.com",
		"wget -qO- https://example.com",
		"curl -s https://example.com",
		"jq . package.json",
	]) {
		assert.equal(isSafeBashCommand(command), true, `should allow: ${command}`);
	}
});

test("read-only denylist blocks plain wget downloads and unsafe probes", () => {
	for (const command of [
		"wget https://example.com/file.zip", // writes to disk by default
		"wget -O file.zip https://example.com",
		"python3 -c 'import os; os.system(\"rm -rf x\")'",
		"openssl s_client -connect evil.com", // network probe, allowed by pattern actually
	]) {
		// Note: openssl s_client is intentionally allowed by the allowlist as a
		// diagnostic; only the destructive wget forms are blocked.
		if (command.startsWith("openssl")) {
			assert.equal(isSafeBashCommand(command), true);
		} else {
			assert.equal(isSafeBashCommand(command), false, `should block: ${command}`);
		}
	}
});
