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

async function runBeforeProviderRequest(pi, ctx, payload) {
  let current = payload;
  let changed = false;
  for (const handler of pi.handlers.get("before_provider_request") ?? []) {
    const result = await handler({ payload: current }, ctx);
    if (result !== undefined) {
      current = result;
      changed = true;
    }
  }
  return changed ? current : undefined;
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

const anthropicPayload = {
  messages: [
    {
      role: "user",
      content: [{ type: "text", text: "hello" }],
    },
  ],
};

const patchedAnthropic = await runBeforeProviderRequest(pi, ctx, anthropicPayload);
assert.ok(patchedAnthropic, "should patch provider payload when AGENTS context exists");
assert.equal(patchedAnthropic.messages.length, 2);
assert.equal(patchedAnthropic.messages[1].role, "user");
assert.match(patchedAnthropic.messages[1].content[0].text, /subdirectory_agents_context/);
assert.equal(pi.sent.length, 1, "should emit one visible load signal when persisted context has not been signaled yet");
assert.equal(pi.sent[0]?.content, "Loaded josxa-dev/AGENTS.md");

const alreadyInjected = await runBeforeProviderRequest(pi, ctx, patchedAnthropic);
assert.equal(alreadyInjected, undefined, "should not duplicate injected AGENTS context in provider payload");
assert.equal(pi.sent.length, 1, "should not re-signal once the load signal is persisted in branch history");

const stringPayload = {
  messages: [
    {
      role: "user",
      content: "hello",
    },
  ],
};

const patchedString = await runBeforeProviderRequest(pi, ctx, stringPayload);
assert.equal(patchedString.messages.length, 2);
assert.equal(typeof patchedString.messages[1].content, "string");
assert.match(patchedString.messages[1].content, /josxa-dev\/AGENTS.md/);

const alreadyInjectedString = {
  messages: [
    { role: "user", content: "hello" },
    { role: "user", content: "<subdirectory_agents_context>cached</subdirectory_agents_context>" },
  ],
};

const unchanged = await runBeforeProviderRequest(pi, ctx, alreadyInjectedString);
assert.equal(unchanged, undefined, "should leave payload alone when AGENTS context is already present");

console.log("subdir provider payload test passed");
