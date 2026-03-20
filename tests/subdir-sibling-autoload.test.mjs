import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

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

const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-workflows-sibling-"));
const cwd = path.join(root, "globaltimezonebot");
const sibling = path.join(root, "josxa-dev");
await fs.mkdir(path.join(cwd, "src"), { recursive: true });
await fs.mkdir(path.join(cwd, ".git"), { recursive: true });
await fs.mkdir(path.join(sibling, ".agent"), { recursive: true });
await fs.mkdir(path.join(sibling, ".git"), { recursive: true });
await fs.writeFile(path.join(sibling, "AGENTS.md"), "# sibling agents\n");
await fs.writeFile(path.join(sibling, ".agent", "guidelines.md"), "rules\n");

const pi = mockPi();
extension(pi);

const branchEntries = [];
const ctx = {
  cwd,
  hasUI: false,
  sessionManager: {
    getBranch() {
      return branchEntries;
    },
  },
};

pi.handlers.get("session_start")?.({}, ctx);

const nestedFile = path.join(sibling, ".agent", "guidelines.md");
const nestedResult = await pi.handlers.get("tool_result")?.({
  toolName: "read",
  isError: false,
  input: { path: nestedFile },
  details: {},
}, ctx);

const expectedRelative = path.relative(cwd, path.join(sibling, "AGENTS.md")).replaceAll("\\", "/");
assert.deepEqual(
  persistedFiles(nestedResult?.details).map((entry) => entry.path),
  [expectedRelative],
  "reading a file in a sibling repo should persist that repo's AGENTS.md",
);
assert.equal(pi.sent[0]?.content, `Loaded ${expectedRelative}`);

branchEntries.push({
  type: "message",
  message: {
    role: "toolResult",
    details: nestedResult?.details,
  },
});

const directAgentsResult = await pi.handlers.get("tool_result")?.({
  toolName: "read",
  isError: false,
  input: { path: path.join(sibling, "AGENTS.md") },
  details: {},
}, ctx);
assert.equal(directAgentsResult, undefined, "reading the AGENTS file again should not duplicate persisted context");

await fs.rm(root, { recursive: true, force: true });
console.log("subdir sibling autoload test passed");
