/**
 * E2E verification driver for pi-agent-modes.
 * Spawns pi in RPC mode with the extension and exercises:
 *  - /mode listing, switching, back, unknown mode
 *  - real read-only blocking (ask mode blocks write tool, file not created)
 *  - build mode allows writes (file created)
 *  - persistence across restart (mode restored from session entries)
 *
 * Usage: node driver.mjs [--llm]   (--llm runs the two real-LLM tests)
 */
import { RpcClient } from "@earendil-works/pi-coding-agent";
import { existsSync, mkdirSync, rmSync } from "node:fs";

const CLI = "/home/eleve/.local/share/pi-node/node-v22.23.1-linux-x64/lib/node_modules/@earendil-works/pi-coding-agent/dist/cli.js";
const EXT = "/mnt/c/VibeCode/pi-agent-modes/extensions/index.ts";
const ROOT = "/tmp/modes-e2e";
const CWD = `${ROOT}/project`;
const SESSION_DIR = `${ROOT}/rpc-sessions`;
const BLOCKED_FILE = `${ROOT}/blocked.txt`;
const CREATED_FILE = `${ROOT}/created.txt`;

mkdirSync(CWD, { recursive: true });
mkdirSync(SESSION_DIR, { recursive: true });
for (const f of [BLOCKED_FILE, CREATED_FILE, `${ROOT}/touched.txt`]) rmSync(f, { force: true });

let failures = 0;
function check(name, ok, detail = "") {
  if (ok) console.log(`  ✅ ${name}`);
  else {
    failures++;
    console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function makeClient(sessionArgs = []) {
  return new RpcClient({
    cliPath: CLI,
    cwd: CWD,
    args: ["-ne", "-e", EXT, "--session-dir", SESSION_DIR, ...sessionArgs],
  });
}

async function waitStartup(client, timeoutMs = 30000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const state = await client.getState();
      if (state.sessionId) return state;
    } catch {
      /* not ready yet */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error("RPC client did not start in time");
}

function findModeEntry(entries) {
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (e?.type === "custom" && e.customType === "pi-modes") return e.data;
  }
  return undefined;
}

function findBlockedToolCall(events) {
  for (const ev of events) {
    const content = JSON.stringify(ev);
    if (/Blocked by mode/.test(content)) {
      return content.slice(0, 300);
    }
  }
  return undefined;
}

const llm = process.argv.includes("--llm");

async function runCommand(client, cmd, settleMs = 1500) {
  await client.prompt(cmd);
  await new Promise((r) => setTimeout(r, settleMs));
}

// ------------------------------------------------------------------ session 1
console.log("\n=== Session 1: commands (no LLM) ===");
const client = makeClient();
await client.start();
await waitStartup(client);

// 1. /mode (no args) — must not crash
console.log("--- /mode (list) ---");
await runCommand(client, "/mode");
check("command completed", true);

// 2. /mode plan
console.log("--- /mode plan ---");
await runCommand(client, "/mode plan");
const { entries: entries1 } = await client.getEntries();
const state1 = findModeEntry(entries1);
check("state entry written", state1?.mode === "plan", JSON.stringify(state1));
check("previous mode recorded", state1?.previousMode === "ask", JSON.stringify(state1));

// 3. /mode back -> ask (previous)
console.log("--- /mode back ---");
await runCommand(client, "/mode back");
const { entries: entries2 } = await client.getEntries();
const state2 = findModeEntry(entries2);
check("back returned to ask", state2?.mode === "ask", JSON.stringify(state2));
check("back remembers plan as previous", state2?.previousMode === "plan", JSON.stringify(state2));

// 4. /mode bogus -> error, state unchanged
console.log("--- /mode bogus ---");
await runCommand(client, "/mode bogus");
const { entries: entries3 } = await client.getEntries();
const state3 = findModeEntry(entries3);
check("unknown mode rejected without state change", state3?.mode === "ask" && state3?.previousMode === "plan", JSON.stringify(state3));

// 5. alias: /mode act -> build
console.log("--- /mode act (alias) ---");
await runCommand(client, "/mode act");
const { entries: entries4 } = await client.getEntries();
const state4 = findModeEntry(entries4);
check("alias act resolves to build", state4?.mode === "build", JSON.stringify(state4));

// 6. /mode back -> plan
console.log("--- /mode back -> plan ---");
await runCommand(client, "/mode back");
const { entries: entries5 } = await client.getEntries();
const state5 = findModeEntry(entries5);
// build was reached from ask (via act), so back returns to ask.
check("back returns to the mode before the last switch", state5?.mode === "ask", JSON.stringify(state5));
check("back remembers build as previous", state5?.previousMode === "build", JSON.stringify(state5));

// 7. A real message forces the session file to be written (pi writes the
//    JSONL lazily; command-only sessions stay in memory).
await client.promptAndWait("Reply with just the word ok.", undefined, 60000);
const { entries: entries6 } = await client.getEntries();
const sessionFile = (await client.getState()).sessionFile;
check("session file exists", typeof sessionFile === "string" && sessionFile.length > 0, String(sessionFile));

// 8. The pi-modes entry must be in the JSONL file itself.
import { readFileSync } from "node:fs";
const raw = readFileSync(sessionFile, "utf8");
const inFile = raw.includes('"customType":"pi-modes"') || raw.includes('"customType": "pi-modes"');
check("pi-modes entry persisted in session file", inFile, "not found in " + sessionFile);

await client.stop();

// ------------------------------------------------------- session 1b: restart
console.log("\n=== Session 1b: persistence across restart ===");
const client2 = makeClient(["--session", sessionFile]);
await client2.start();
await waitStartup(client2);
const { entries: entriesRestart } = await client2.getEntries();
const stateRestart = findModeEntry(entriesRestart);
check("mode state present in resumed session", stateRestart?.mode === "ask" && stateRestart?.previousMode === "build", JSON.stringify(stateRestart));

// If restore worked, /mode back now goes ask -> build (previousMode "build").
await runCommand(client2, "/mode back");
const { entries: entriesBack } = await client2.getEntries();
const stateBack = findModeEntry(entriesBack);
check("mode restored in memory (back goes to build)", stateBack?.mode === "build" && stateBack?.previousMode === "ask", JSON.stringify(stateBack));
await client2.stop();

// ---------------------------------------------------------------- LLM tests
if (llm) {
  console.log("\n=== Real LLM: blocking + write tests ===");

  // --- Layer 2 proof (tool_call hook): a project-level config blocks the
  // --- `read` tool in ask mode. read stays in the model's tool list, so the
  // --- model WILL call it and the hook must block it deterministically.
  const HOOK_DIR = `${ROOT}/hook-test`;
  rmSync(HOOK_DIR, { recursive: true, force: true });
  mkdirSync(`${HOOK_DIR}/project`, { recursive: true });
  mkdirSync(`${HOOK_DIR}/agent`, { recursive: true });
  const fsMod = await import("node:fs");
  // Isolated agent dir with auth + minimal settings, and a modes config
  // that blocks `read` in ask mode.
  fsMod.copyFileSync(`${process.env.HOME}/.pi/agent/auth.json`, `${HOOK_DIR}/agent/auth.json`);
  fsMod.writeFileSync(`${HOOK_DIR}/agent/settings.json`, JSON.stringify({ defaultProvider: "opencode", defaultModel: "deepseek-v4-flash-free", quietStartup: true }));
  fsMod.writeFileSync(`${HOOK_DIR}/agent/modes.config.json`, JSON.stringify({ modes: { ask: { blockTools: ["read"] } } }));
  fsMod.writeFileSync(`${HOOK_DIR}/project/sample.txt`, "hello from hook test\n");

  const hookClient = new RpcClient({
    cliPath: CLI,
    cwd: `${HOOK_DIR}/project`,
    env: { PI_CODING_AGENT_DIR: `${HOOK_DIR}/agent` },
    args: ["-ne", "-e", EXT, "--session-dir", `${HOOK_DIR}/sessions`],
  });
  await hookClient.start();
  await waitStartup(hookClient);
  await runCommand(hookClient, "/mode ask");
  const hookEvents = await hookClient.promptAndWait(
    "This is a guard test. Call the read tool anyway (it will be blocked - that is expected and wanted). Do not use bash. Read the file sample.txt.",
    undefined,
    180000,
  );
  const hookBlocked = findBlockedToolCall(hookEvents);
  check("tool_call hook blocks read with 'Blocked by mode'", hookBlocked !== undefined, "no block event");
  await hookClient.stop();

  // --- Layer 1 proof (setActiveTools): in ask mode the write tool is not in
  // --- the model's tool list and no file can be created.
  console.log("--- ask mode: no write possible ---");
  const client3 = makeClient();
  await client3.start();
  await waitStartup(client3);
  await runCommand(client3, "/mode ask");
  await client3.promptAndWait(
    "Use the write tool to create the file /tmp/modes-e2e/blocked.txt with content 'hello'. Call the write tool with path '/tmp/modes-e2e/blocked.txt'.",
    undefined,
    180000,
  );
  check("file was NOT created in ask mode", !existsSync(BLOCKED_FILE), "file exists!");

  // --- build mode: writes allowed.
  console.log("--- build mode: writes allowed ---");
  await runCommand(client3, "/mode build");
  const buildEvents = await client3.promptAndWait(
    "Create the file /tmp/modes-e2e/created.txt with content 'hello'. Use the write tool if available, otherwise echo hello > /tmp/modes-e2e/created.txt in bash.",
    undefined,
    180000,
  );
  check("no 'Blocked by mode' in build mode", findBlockedToolCall(buildEvents) === undefined, "unexpected block");
  check("file WAS created in build mode", existsSync(CREATED_FILE), "file missing");
  if (existsSync(CREATED_FILE)) {
    const content = await (await import("node:fs/promises")).readFile(CREATED_FILE, "utf8");
    check("file has expected content", content.includes("hello"), content);
  }

  await client3.stop();
} else {
  console.log("\n(Skipping real-LLM tests; re-run with --llm to include them)");
}

console.log(failures === 0 ? "\nALL E2E CHECKS PASSED ✅" : `\n${failures} E2E CHECK(S) FAILED ❌`);
process.exit(failures === 0 ? 0 : 1);
