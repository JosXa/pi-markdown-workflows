import assert from "node:assert/strict";
import fs from "node:fs/promises";

import extension from "../dist/index.js";

const config = JSON.parse(
  await fs.readFile(new URL("../config.json", import.meta.url), "utf-8"),
);
const recency = config.dotagentsRecency;
assert.equal(recency, 7, "test expects config recency window to stay at 7");

function makeBranch(assistantCount) {
  const branch = [
    {
      type: "message",
      message: {
        role: "toolResult",
        details: {
          subdirContextAutoload: {
            files: [
              {
                path: "josxa-dev/AGENTS.md",
                content: "# test",
              },
            ],
          },
        },
      },
    },
    {
      type: "custom_message",
      customType: "subdir-context-notify",
      content: "Loaded josxa-dev/AGENTS.md",
      display: true,
      details: { files: ["josxa-dev/AGENTS.md"] },
    },
  ];

  for (let index = 0; index < assistantCount; index += 1) {
    branch.push({
      type: "message",
      message: {
        role: "assistant",
        content: `assistant ${index}`,
      },
    });
  }

  return branch;
}

function mockPi(branchEntries) {
  const handlers = new Map();
  const sent = [];
  return {
    handlers,
    sent,
    on(name, handler) {
      const list = handlers.get(name) ?? [];
      list.push(handler);
      handlers.set(name, list);
    },
    registerFlag() {},
    registerMessageRenderer() {},
    registerTool() {},
    registerCommand() {},
    getFlag() {
      return undefined;
    },
    sendMessage(message) {
      sent.push(message);
      branchEntries.push({
        type: "custom_message",
        customType: message.customType,
        content: message.content,
        display: message.display,
        details: message.details,
      });
    },
  };
}

async function runBeforeProviderRequest(branchEntries) {
  const pi = mockPi(branchEntries);
  extension(pi);
  const ctx = {
    cwd: "D:/projects",
    hasUI: false,
    sessionManager: {
      getBranch() {
        return branchEntries;
      },
    },
  };

  for (const handler of pi.handlers.get("session_start") ?? []) {
    await handler({}, ctx);
  }
  for (const handler of pi.handlers.get("before_agent_start") ?? []) {
    await handler({ prompt: "next", systemPrompt: "base" }, ctx);
  }

  let current = { messages: [{ role: "user", content: "hello" }] };
  let changed = false;
  for (const handler of pi.handlers.get("before_provider_request") ?? []) {
    const result = await handler({ payload: current }, ctx);
    if (result !== undefined) {
      current = result;
      changed = true;
    }
  }

  return { payload: changed ? current : undefined, sent: pi.sent };
}

const withinWindow = await runBeforeProviderRequest(makeBranch(recency - 1));
assert.ok(withinWindow.payload, "must still inject AGENTS context while inside the recency window");
assert.equal(withinWindow.sent.length, 0, "must not emit refresh before crossing recency window");
assert.match(withinWindow.payload.messages[1].content, /subdirectory_agents_context/);

const outsideWindow = await runBeforeProviderRequest(makeBranch(recency));
assert.ok(outsideWindow.payload, "must inject AGENTS context after crossing recency window");
assert.equal(outsideWindow.sent.length, 1, "must emit exactly one visible refresh after crossing recency window");
assert.equal(outsideWindow.sent[0]?.content, "Refreshed josxa-dev/AGENTS.md");
assert.match(outsideWindow.payload.messages[1].content, /subdirectory_agents_context/);

console.log("subdir recency window boundary test passed");
