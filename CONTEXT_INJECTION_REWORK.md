# AGENTS.md Context Injection — Rework Plan

## Original Requirements

1. **Recency window logic**: When visiting a file that triggers an AGENTS.md load:
   - Check if we already have that AGENTS.md in the conversation
   - If it is within the last N messages, skip
   - If it is not, delete the previous occurrence and inject it again at the most recent position
2. **Configurable window**: The recency window (default 10) should be configurable via a dedicated `config.json` file
3. **Visible `↳ Loaded` indicator**: Every time injection happens (first load AND re-injection), show `↳ Loaded <path>/AGENTS.md` inline in the conversation via `pi.sendMessage()` with a custom renderer — NOT the ephemeral `notify()` status bar
4. **No raw XML in conversation**: The context injection itself must be invisible to the TUI; only the `↳ Loaded` notification should be visible

## Current State

- **Context hook is DISABLED** — commented out in `src/core/subdir.ts` (line ~352)
- The `tool_result` hook still works: it discovers AGENTS.md files, reads them, persists content in tool result `details`, and sends `↳ Loaded` notifications via `sendMessage`
- The `↳ Loaded` renderer works correctly (registered for `SUBDIR_CONTEXT_NOTIFY_TYPE`)
- A `config.json` file exists at the extension root with `{ "dotagentsRecency": 10 }` and `getRecencyWindow()` reads it
- `buildInjectedContextMessage()` still exists but is not called from any hook

## Problems Encountered

### 1. `display: false` doesn't work in the `context` hook

The `context` hook returns a modified message array. Pi renders ALL messages in this array in the TUI regardless of the `display` flag. The `display` flag and `registerMessageRenderer` only work for **session entries** created via `pi.sendMessage()`, NOT for messages injected via the context hook.

**Evidence**: The TUI code at `interactive-mode.js:2012` checks `if (message.display)` only in the `case "custom"` block for session entry rendering. Context hook messages go through a completely different rendering path that dumps everything as-is.

### 2. `before_provider_request` not available

The extension's `@mariozechner/pi-coding-agent` dependency is **v0.52.9**. The `before_provider_request` event was added in a later version (the global pi install is v0.58.3 which has it). TypeScript compilation fails with:

```
Argument of type '"before_provider_request"' is not assignable to parameter of type '"input"'.
```

**Fix**: Update `package.json` to require `@mariozechner/pi-coding-agent` >= 0.58.0 and run `npm install`.

### 3. Failed builds don't clear old dist

When `tsc` fails (e.g., type errors), it silently keeps the old `dist/` output. This caused us to think builds succeeded when they didn't — the old buggy code kept running.

**Fix**: Always run `npx tsc --noEmit` first to verify compilation, then `npm run build`. Or add `rm -rf dist` before build.

### 4. Compaction bakes in injected XML

When the context hook injected the raw XML, it got included in compaction summaries. Even after disabling the hook, the compacted content persists in the session and gets echoed back every turn.

**Fix**: Start a fresh session after fixing the injection. Nothing can be done about existing sessions.

## How to Continue

### Step 1: Upgrade the extension's pi dependency

```bash
cd ~/.pi/agent/extensions/pi-markdown-workflows
npm install @mariozechner/pi-coding-agent@latest
```

Verify `before_provider_request` exists in the new types:
```bash
grep "before_provider_request" node_modules/@mariozechner/pi-coding-agent/dist/core/extensions/types.d.ts
```

### Step 2: Implement injection via `before_provider_request`

This hook fires AFTER the TUI has rendered the conversation — modifications to the payload are invisible to the user. Replace the disabled context hook with:

```typescript
pi.on("before_provider_request", (event, ctx) => {
  const branchContext = collectBranchContext(ctx);
  const contextBody = buildContextBodyString(branchContext);
  if (!contextBody) return undefined;

  const payload = event.payload as { messages?: Array<{ role: string; content: unknown }> };
  if (!payload?.messages?.length) return undefined;

  // Check if context already exists in payload (from a previous injection)
  const hasContext = payload.messages.some(m =>
    typeof m.content === "string" && m.content.includes("<subdirectory_agents_context>")
  );
  if (hasContext) return undefined;

  // Append as a user message at the end
  return {
    ...payload,
    messages: [...payload.messages, { role: "user", content: contextBody }],
  };
});
```

### Step 3: Add recency window logic

The recency check should look at the payload messages (which mirror the conversation). Count backwards from the end — if the context tag is found within the last N messages, skip injection. Otherwise inject fresh at the end.

### Step 4: Send `↳ Loaded` notification on re-injection

Track `lastInjectedBody` in a closure variable. When the body changes (new AGENTS.md discovered) or when re-injection happens (drifted out of window), call:

```typescript
pi.sendMessage({
  customType: SUBDIR_CONTEXT_NOTIFY_TYPE,
  content: `Loaded ${file}`,
  display: true,
  details: { files },
});
```

### Step 5: Verify in a fresh session

Start a fresh session (the current one has compacted XML artifacts). Read a file in `D:/projects/leagues/Flow/` and verify:
- `↳ Loaded leagues/Flow/AGENTS.md` appears inline
- No raw XML dump in the conversation
- The LLM receives the AGENTS.md content (check by asking it about the content)

## File Locations

- **Main source**: `~/.pi/agent/extensions/pi-markdown-workflows/src/core/subdir.ts`
- **Config**: `~/.pi/agent/extensions/pi-markdown-workflows/config.json`
- **Extension entry**: `src/extension/register.ts`
- **tsconfig**: targets ES2022, outDir `./dist`
- **Custom types**: `SUBDIR_CONTEXT_MESSAGE_TYPE = "subdir-context-autoload"`, `SUBDIR_CONTEXT_NOTIFY_TYPE = "subdir-context-notify"`

## Key Learnings

1. **Never use the `context` hook to inject custom messages** — they render as raw text in the TUI
2. **Always verify `tsc --noEmit` before `npm run build`** — failed builds silently keep old dist
3. **Always nuke `dist/` when in doubt** — `rm -rf dist && npm run build`
4. **Check the extension's dep version** before using newer API features
5. **The `context` hook modifies both LLM input AND TUI rendering** — there's no way to hide content from the TUI via the context hook
