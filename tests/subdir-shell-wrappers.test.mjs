import assert from "node:assert/strict";

import extension from "../dist/index.js";

function mockPi() {
  const handlers = new Map();
  const sent = [];
  return {
    handlers,
    sent,
    on(name, handler) {
      handlers.set(name, handler);
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

function persistedFiles(details) {
  return details?.subdirContextAutoload?.files ?? [];
}

async function collectViaBash(command) {
  const pi = mockPi();
  extension(pi);

  const branchEntries = [];
  const ctx = {
    cwd: "D:/projects",
    hasUI: false,
    sessionManager: {
      getBranch() {
        return branchEntries;
      },
    },
  };

  pi.handlers.get("session_start")?.({}, ctx);
  const result = await pi.handlers.get("tool_result")?.({
    toolName: "bash",
    isError: false,
    input: { command },
    details: {},
  }, ctx);

  return {
    result,
    sent: pi.sent,
    files: persistedFiles(result?.details).map((entry) => entry.path),
  };
}

const plain = await collectViaBash("rg -n jeff D:/projects/josxa-dev");
assert.deepEqual(plain.files, ["josxa-dev/AGENTS.md"]);
assert.equal(plain.sent[0]?.content, "Loaded josxa-dev/AGENTS.md");
assert.equal(plain.sent.length, 1);

const nuWrapped = await collectViaBash('nu -c "cd D:/projects/josxa-dev; rg -n jeff ."');
assert.deepEqual(nuWrapped.files, ["josxa-dev/AGENTS.md"]);
assert.equal(nuWrapped.sent[0]?.content, "Loaded josxa-dev/AGENTS.md");

const bashWrapped = await collectViaBash('bash -lc "cd D:/projects/josxa-dev && ls ."');
assert.deepEqual(bashWrapped.files, ["josxa-dev/AGENTS.md"]);
assert.equal(bashWrapped.sent[0]?.content, "Loaded josxa-dev/AGENTS.md");

console.log("subdir shell wrapper test passed");
