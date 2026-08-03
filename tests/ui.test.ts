import { test } from "node:test";
import assert from "node:assert/strict";
import { modeNotificationText, modeStatusText, modeColor } from "../src/ui.ts";
import { applyOverride } from "../src/config.ts";
import { ModeRegistry } from "../src/modes/registry.ts";

const registry = new ModeRegistry();

function mode(name: string) {
	return applyOverride(registry.resolve(name)!, undefined);
}

test("modeNotificationText is short and consistent", () => {
	assert.equal(modeNotificationText(mode("build")), "mode: build ~ full access.");
	assert.equal(modeNotificationText(mode("debug")), "mode: debug ~ full access.");
	assert.equal(modeNotificationText(mode("yolo")), "mode: yolo ~ full access.");
	assert.equal(modeNotificationText(mode("ask")), "mode: ask ~ read-only.");
	assert.equal(modeNotificationText(mode("plan")), "mode: plan ~ read-only.");
	assert.equal(modeNotificationText(mode("review")), "mode: review ~ read-only.");
});

test("modeNotificationText reflects a restricted-bash override", () => {
	const build = applyOverride(registry.resolve("build")!, { bash: "readOnly" });
	assert.equal(modeNotificationText(build), "mode: build ~ writes allowed, restricted bash.");
});

test("modeStatusText and modeColor stay intact", () => {
	const theme = { fg: (_color: string, text: string) => text };
	assert.equal(modeStatusText(mode("plan"), theme), "Ⓜ plan 🔒");
	assert.equal(modeStatusText(mode("yolo"), theme), "Ⓜ yolo");
	assert.equal(modeColor(mode("ask")), "muted");
	assert.equal(modeColor(mode("build")), "success");
});
