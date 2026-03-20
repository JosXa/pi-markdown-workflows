import assert from "node:assert/strict";

import extension from "../dist/index.js";

const branchEntries = [
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
  {
    type: "message",
    message: {
      role: "assistant",
      content: "done",
    },
  },
];

function mockPi() {
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
    },
  };
}

const pi = mockPi();
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
  await handler({
    prompt: "next",
    systemPrompt: "base",
  }, ctx);
}
assert.equal(pi.sent.length, 0, "should not show a refresh notification during before_agent_start anymore");

let patched;
for (const handler of pi.handlers.get("before_provider_request") ?? []) {
  patched = await handler({ payload: { messages: [{ role: "user", content: "hello" }] } }, ctx) ?? patched;
}
assert.ok(patched, "should still inject AGENTS context while prior signal is within the recency window");
assert.equal(pi.sent.length, 0, "should not re-signal while prior injection is within recency window");
assert.match(patched.messages[1].content, /subdirectory_agents_context/);

console.log("subdir reinjection recency test passed");
