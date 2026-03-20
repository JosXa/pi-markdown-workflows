import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { normalizeAtPrefix } from "./workflow.js";

const SUBDIR_CONTEXT_MESSAGE_TYPE = "subdir-context-autoload";
const SUBDIR_CONTEXT_NOTIFY_TYPE = "subdir-context-notify";

const SUBDIR_CONTEXT_DETAILS_KEY = "subdirContextAutoload";

const DEFAULT_RECENCY_WINDOW = 10;

interface SubdirConfig {
  dotagentsRecency?: number;
}

function loadConfig(): SubdirConfig {
  const configPath = path.join(os.homedir(), ".pi", "agent", "extensions", "pi-markdown-workflows", "config.json");
  try {
    const raw = fs.readFileSync(configPath, "utf-8");
    return JSON.parse(raw) as SubdirConfig;
  } catch {
    return {};
  }
}

function getRecencyWindow(pi: ExtensionAPI): number {
  // CLI flag takes precedence over config file
  const flagValue = pi.getFlag("--dotagents-recency");
  if (flagValue !== undefined && flagValue !== "10") {
    const parsed = parseInt(String(flagValue), 10);
    if (!isNaN(parsed) && parsed >= 1) return parsed;
  }
  const config = loadConfig();
  if (config.dotagentsRecency !== undefined && config.dotagentsRecency >= 1) {
    return config.dotagentsRecency;
  }
  return DEFAULT_RECENCY_WINDOW;
}

type PersistedContextFile = { path: string; content: string };

type PersistedContextDetails = {
  files: PersistedContextFile[];
};

function resolvePath(targetPath: string, baseDir: string): string {
  const cleaned = normalizeAtPrefix(targetPath);
  const absolute = path.isAbsolute(cleaned)
    ? path.normalize(cleaned)
    : path.resolve(baseDir, cleaned);
  try {
    return fs.realpathSync.native?.(absolute) ?? fs.realpathSync(absolute);
  } catch {
    return absolute;
  }
}

function isInsideRoot(rootDir: string, targetPath: string): boolean {
  if (!rootDir) return false;
  const relative = path.relative(rootDir, targetPath);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function nearestExistingPath(targetPath: string): string {
  let current = path.normalize(targetPath);
  for (;;) {
    if (fs.existsSync(current)) return current;
    const parent = path.dirname(current);
    if (parent === current) return current;
    current = parent;
  }
}

function findRepositoryRoot(targetPath: string): string {
  const existing = nearestExistingPath(targetPath);
  let dir = fs.existsSync(existing) && fs.statSync(existing).isDirectory()
    ? existing
    : path.dirname(existing);

  for (;;) {
    if (
      fs.existsSync(path.join(dir, ".git"))
      || fs.existsSync(path.join(dir, ".jj"))
      || fs.existsSync(path.join(dir, ".hg"))
    ) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) return "";
    dir = parent;
  }
}

function searchRootForTarget(targetPath: string, cwdRoot: string, homeRoot: string): string {
  if (isInsideRoot(cwdRoot, targetPath)) return cwdRoot;
  if (isInsideRoot(homeRoot, targetPath)) return homeRoot;

  const repoRoot = findRepositoryRoot(targetPath);
  if (repoRoot) return repoRoot;

  const existing = nearestExistingPath(targetPath);
  const dir = fs.existsSync(existing) && fs.statSync(existing).isDirectory()
    ? existing
    : path.dirname(existing);
  return path.parse(dir).root;
}

function stripWrappingQuotes(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length < 2) return trimmed;
  const first = trimmed[0];
  const last = trimmed[trimmed.length - 1];
  if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function splitCommandTokens(value: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;

  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (quote) {
      if (char === quote) {
        quote = null;
      } else {
        current += char;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (current) {
        tokens.push(current);
        current = "";
      }
      continue;
    }
    current += char;
  }

  if (current) tokens.push(current);
  return tokens;
}

function splitShellSegments(value: string): string[] {
  const segments: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;

  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    const next = value[index + 1];
    if (quote) {
      if (char === quote) quote = null;
      current += char;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      current += char;
      continue;
    }
    const isDoubleSeparator = (char === "&" && next === "&") || (char === "|" && next === "|");
    if (char === ";" || char === "|" || isDoubleSeparator) {
      const segment = current.trim();
      if (segment) segments.push(segment);
      current = "";
      if (isDoubleSeparator) index += 1;
      continue;
    }
    current += char;
  }

  const tail = current.trim();
  if (tail) segments.push(tail);
  return segments;
}

function unwrapShellCommand(value: string): string {
  let current = value.trim();
  for (;;) {
    const next =
      current.match(/^(?:nu|bash|sh|zsh)\s+-(?:l?c)\s+([\s\S]+)$/i)?.[1]
      ?? current.match(/^(?:pwsh|powershell)(?:\.exe)?\s+-(?:c|command)\s+([\s\S]+)$/i)?.[1]
      ?? current.match(/^cmd(?:\.exe)?\s+\/c\s+([\s\S]+)$/i)?.[1];
    if (!next) return current;
    const unwrapped = stripWrappingQuotes(next);
    if (unwrapped === current) return current;
    current = unwrapped.trim();
  }
}

function isDiscoveryCommandSegment(value: string): boolean {
  const parts = splitCommandTokens(value.toLowerCase());
  if (!parts.length) return false;
  const command = parts[0] ?? "";
  const names = new Set(["ls", "find", "rg", "grep", "fd", "tree", "git"]);
  if (command !== "git") return names.has(command);
  const subcommand = parts[1] ?? "";
  return subcommand === "ls-files" || subcommand === "grep";
}

function resolveCdSegment(value: string, base: string): string | null {
  const parts = splitCommandTokens(value);
  if (!parts.length || parts[0]?.toLowerCase() !== "cd") return null;
  let targetIndex = 1;
  while (parts[targetIndex]?.startsWith("-")) targetIndex += 1;
  const target = parts[targetIndex];
  if (!target) return base;
  if (target === "~") return resolvePath(os.homedir(), base);
  return resolvePath(target, base);
}

function segmentTargets(value: string, base: string): string[] {
  const parts = splitCommandTokens(value);
  if (!parts.length) return [base];
  const paths: string[] = [];
  for (let index = 1; index < parts.length; index += 1) {
    const item = parts[index];
    if (!item) continue;
    if (item.startsWith("-")) continue;
    if (item.includes("=")) continue;
    if (item === ".") {
      paths.push(base);
      continue;
    }
    if (item === "~") {
      paths.push(resolvePath(os.homedir(), base));
      continue;
    }
    if (item.startsWith("/")) {
      paths.push(resolvePath(item, base));
      continue;
    }
    if (item.startsWith("./") || item.startsWith("../") || item.includes("/") || item.includes("\\")) {
      paths.push(resolvePath(item, base));
    }
  }
  if (!paths.length) return [base];
  return paths;
}

function isDiscoveryBashCommand(value: string): boolean {
  const command = unwrapShellCommand(value);
  return splitShellSegments(command).some((segment) => isDiscoveryCommandSegment(segment));
}

function bashTargets(value: string, base: string): string[] {
  const command = unwrapShellCommand(value);
  const segments = splitShellSegments(command);
  let currentBase = base;
  const paths: string[] = [];
  let sawDiscovery = false;

  for (const segment of segments) {
    const changedDir = resolveCdSegment(segment, currentBase);
    if (changedDir !== null) {
      currentBase = changedDir;
      continue;
    }
    if (!isDiscoveryCommandSegment(segment)) continue;
    sawDiscovery = true;
    paths.push(...segmentTargets(segment, currentBase));
  }

  if (!sawDiscovery) return [];
  if (!paths.length) return [currentBase];
  return [...new Set(paths)];
}

function parsePersistedContextDetails(details: unknown): PersistedContextDetails | null {
  if (!details || typeof details !== "object" || Array.isArray(details)) return null;
  const value = (details as Record<string, unknown>)[SUBDIR_CONTEXT_DETAILS_KEY];
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const files = (value as Record<string, unknown>).files;
  if (!Array.isArray(files)) return null;
  const parsed = files
    .filter((item): item is PersistedContextFile => {
      if (!item || typeof item !== "object" || Array.isArray(item)) return false;
      const pathValue = (item as Record<string, unknown>).path;
      const contentValue = (item as Record<string, unknown>).content;
      return typeof pathValue === "string" && typeof contentValue === "string";
    })
    .map((item) => ({ path: item.path, content: item.content }));
  if (!parsed.length) return null;
  return { files: parsed };
}

function mergePersistedContextDetails(
  baseDetails: unknown,
  injected: PersistedContextDetails,
): Record<string, unknown> {
  if (baseDetails && typeof baseDetails === "object" && !Array.isArray(baseDetails)) {
    return {
      ...(baseDetails as Record<string, unknown>),
      [SUBDIR_CONTEXT_DETAILS_KEY]: injected,
    };
  }
  return { [SUBDIR_CONTEXT_DETAILS_KEY]: injected };
}

export function registerSubdirContextAutoload(pi: ExtensionAPI): void {
  pi.registerFlag("dotagents-recency", {
    description: "Number of recent messages to keep AGENTS.md context within (default: 10)",
    type: "string",
    default: "10",
  });

  // Renderer for visible load/refresh notifications
  pi.registerMessageRenderer(SUBDIR_CONTEXT_NOTIFY_TYPE, (message, _options, theme) => {
    const details = message.details as { files?: string[] } | undefined;
    const files = details?.files ?? [];
    const verb = typeof message.content === "string" && message.content.startsWith("Loaded") ? "Loaded" : "Refreshed";
    const lines = files.map((f) => theme.fg("dim", `↳ ${verb} ${f}`));
    return new Text(lines.join("\n"), 0, 0);
  });

  const loadedAgents = new Set<string>();
  const loadedAgentsContent = new Map<string, string>();
  let currentCwd = "";
  let cwdAgentsPath = "";
  let homeDir = "";
  let readCount = 0;

  function relativePath(absolutePath: string): string {
    const relative = currentCwd ? path.relative(currentCwd, absolutePath) : absolutePath;
    return (relative || absolutePath).replaceAll("\\", "/");
  }

  function resetSession(cwd: string): void {
    currentCwd = resolvePath(cwd, process.cwd());
    cwdAgentsPath = path.join(currentCwd, "AGENTS.md");
    homeDir = resolvePath(os.homedir(), process.cwd());
    readCount = 0;
    loadedAgents.clear();
    loadedAgentsContent.clear();
    loadedAgents.add(cwdAgentsPath);
  }

  function ensureSession(cwd: string): void {
    if (!currentCwd) resetSession(cwd);
  }

  function collectBranchContext(ctx: ExtensionContext): Map<string, string> {
    ensureSession(ctx.cwd);
    const out = new Map<string, string>();
    const branchEntries = ctx.sessionManager.getBranch();
    for (const entry of branchEntries) {
      if (!entry || typeof entry !== "object" || entry.type !== "message") continue;
      const message = (entry as { message?: unknown }).message;
      if (!message || typeof message !== "object" || Array.isArray(message)) continue;
      if ((message as { role?: unknown }).role !== "toolResult") continue;
      const details = (message as { details?: unknown }).details;
      const persisted = parsePersistedContextDetails(details);
      if (!persisted) continue;
      for (const file of persisted.files) {
        const absolute = resolvePath(file.path, currentCwd);
        if (path.basename(absolute) !== "AGENTS.md" || absolute === cwdAgentsPath) continue;
        out.set(absolute, file.content);
      }
    }
    return out;
  }

  /** Full reset — rebuilds runtime state from branch. Use at turn boundaries. */
  function resetRuntimeFromBranch(branchContext: Map<string, string>): void {
    loadedAgents.clear();
    loadedAgents.add(cwdAgentsPath);
    loadedAgentsContent.clear();
    for (const [agentsPath, content] of branchContext.entries()) {
      loadedAgents.add(agentsPath);
      loadedAgentsContent.set(agentsPath, content);
    }
  }

  /** Merge-only — adds branch context without clearing in-memory state.
   *  Use within a turn (tool_result) to avoid clobbering additions from
   *  earlier tool_result handlers whose details haven't persisted yet. */
  function mergeRuntimeFromBranch(branchContext: Map<string, string>): void {
    loadedAgents.add(cwdAgentsPath);
    for (const [agentsPath, content] of branchContext.entries()) {
      loadedAgents.add(agentsPath);
      loadedAgentsContent.set(agentsPath, content);
    }
  }

  function findAgentsFiles(filePath: string, rootDir: string): string[] {
    if (!rootDir) return [];
    const agentsFiles: string[] = [];
    let dir = path.dirname(filePath);
    while (isInsideRoot(rootDir, dir)) {
      const candidate = path.join(dir, "AGENTS.md");
      if (candidate !== cwdAgentsPath && fs.existsSync(candidate)) agentsFiles.push(candidate);
      if (dir === rootDir) break;
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
    return agentsFiles.reverse();
  }

  function buildInjectedContextBody(branchContext: Map<string, string>): string | null {
    if (!branchContext.size) return null;
    const files = [...branchContext.entries()].sort(([a], [b]) => a.localeCompare(b));
    const body = files
      .map(([agentsPath, content]) => {
        const rel = relativePath(agentsPath);
        return `<agents_file path="${rel}">\n${content}\n</agents_file>`;
      })
      .join("\n\n");
    return [
      "<subdirectory_agents_context>",
      "Automatically loaded AGENTS.md context relevant to recently accessed files.",
      body,
      "</subdirectory_agents_context>",
    ].join("\n");
  }

  function payloadContainsInjectedContext(value: unknown): boolean {
    if (typeof value === "string") return value.includes("<subdirectory_agents_context>");
    if (Array.isArray(value)) return value.some((item) => payloadContainsInjectedContext(item));
    if (value && typeof value === "object") {
      return Object.values(value as Record<string, unknown>).some((item) => payloadContainsInjectedContext(item));
    }
    return false;
  }

  function appendInjectedContextToPayload(payload: unknown, body: string): unknown {
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) return payload;
    const record = payload as Record<string, unknown>;
    const messages = record.messages;
    if (!Array.isArray(messages) || payloadContainsInjectedContext(messages)) return payload;

    const sampleMessage = messages.find((item) => item && typeof item === "object" && !Array.isArray(item)) as
      | Record<string, unknown>
      | undefined;
    const injectedMessage = Array.isArray(sampleMessage?.content)
      ? { role: "user", content: [{ type: "text", text: body }] }
      : { role: "user", content: body };

    return {
      ...record,
      messages: [...messages, injectedMessage],
    };
  }

  function countAssistantMessagesSinceLastSignal(ctx: ExtensionContext): number | null {
    const branch = ctx.sessionManager.getBranch();
    let assistantCount = 0;
    // Walk backwards from the end of the branch
    for (let i = branch.length - 1; i >= 0; i--) {
      const entry = branch[i];
      if (!entry || typeof entry !== "object") continue;
      if (entry.type === "custom_message") {
        const customType = (entry as { customType?: unknown }).customType;
        if (customType === SUBDIR_CONTEXT_NOTIFY_TYPE || customType === SUBDIR_CONTEXT_MESSAGE_TYPE) {
          return assistantCount;
        }
        continue;
      }
      if (entry.type !== "message") continue;
      const message = (entry as { message?: unknown }).message;
      if (!message || typeof message !== "object" || Array.isArray(message)) continue;
      const role = (message as { role?: unknown }).role;
      const customType = (message as { customType?: unknown }).customType;
      if (role === "custom" && customType === SUBDIR_CONTEXT_MESSAGE_TYPE) {
        return assistantCount;
      }
      if (role === "assistant") {
        assistantCount++;
      }
    }
    return null;
  }

  function sendContextSignal(kind: "loaded" | "refreshed", files: string[]): void {
    if (!files.length) return;
    pi.sendMessage({
      customType: SUBDIR_CONTEXT_NOTIFY_TYPE,
      content: kind === "loaded"
        ? files.length === 1
          ? `Loaded ${files[0]}`
          : `Loaded ${files.length} AGENTS.md files`
        : files.length === 1
          ? `Refreshed ${files[0]}`
          : `Refreshed ${files.length} AGENTS.md files`,
      display: true,
      details: { files },
    });
  }

  const handleSessionChange = (_event: unknown, ctx: ExtensionContext): void => {
    resetSession(ctx.cwd);
  };

  pi.on("session_start", handleSessionChange);
  pi.on("session_switch", handleSessionChange);
  pi.on("session_tree", handleSessionChange);

  // Keep runtime state aligned with persisted branch context, but do not signal here.
  // before_agent_start only runs for user prompts, while provider injection also needs
  // to refresh during assistant/tool-driven follow-up requests.
  pi.on("before_agent_start", (_event, ctx) => {
    ensureSession(ctx.cwd);
    const branchContext = collectBranchContext(ctx);
    resetRuntimeFromBranch(branchContext);
    return undefined;
  });

  pi.on("before_provider_request", (event, ctx) => {
    ensureSession(ctx.cwd);
    const branchContext = collectBranchContext(ctx);
    if (!branchContext.size) return undefined;

    const recency = getRecencyWindow(pi);
    const sinceLastSignal = countAssistantMessagesSinceLastSignal(ctx);
    if (sinceLastSignal === null || sinceLastSignal >= recency) {
      const files = [...branchContext.keys()].map((p) => relativePath(p));
      sendContextSignal(sinceLastSignal === null ? "loaded" : "refreshed", files);
    }

    const body = buildInjectedContextBody(branchContext);
    if (!body) return undefined;

    const patched = appendInjectedContextToPayload(event.payload, body);
    return patched === event.payload ? undefined : patched;
  });

  pi.on("tool_result", async (event, ctx) => {
    if (event.isError) return undefined;
    const isRead = event.toolName === "read";
    const isBash = event.toolName === "bash";
    if (!isRead && !isBash) return undefined;
    const pathInput = event.input.path as string | undefined;
    const bashInput = event.input.command as string | undefined;
    const isDiscoveryBash =
      isBash && typeof bashInput === "string" && isDiscoveryBashCommand(bashInput);
    if (!isRead && !isDiscoveryBash) return undefined;

    ensureSession(ctx.cwd);
    const branchContext = collectBranchContext(ctx);
    mergeRuntimeFromBranch(branchContext);

    readCount += 1;

    const targets = isRead
      ? pathInput
        ? [resolvePath(pathInput, currentCwd)]
        : []
      : bashInput
        ? bashTargets(bashInput, currentCwd)
        : [];
    if (!targets.length) return undefined;

    const paths = new Set<string>();
    for (const target of targets) {
      const searchRoot = searchRootForTarget(target, currentCwd, homeDir);
      if (!searchRoot) continue;
      const probe =
        fs.existsSync(target) && fs.statSync(target).isDirectory()
          ? path.join(target, "__probe__")
          : target;
      const files = findAgentsFiles(probe, searchRoot);
      for (const file of files) paths.add(file);
    }

    const agentFiles = [...paths];
    if (!agentFiles.length) return undefined;

    const loadedNow: string[] = [];
    const persistedFiles: PersistedContextFile[] = [];

    for (const agentsPath of agentFiles) {
      try {
        const content = await fs.promises.readFile(agentsPath, "utf-8");
        const wasLoaded = loadedAgents.has(agentsPath);
        loadedAgents.add(agentsPath);
        loadedAgentsContent.set(agentsPath, content);
        const branchContent = branchContext.get(agentsPath);
        if (branchContent !== content) {
          persistedFiles.push({ path: relativePath(agentsPath), content });
        }
        if (!wasLoaded) loadedNow.push(relativePath(agentsPath));
      } catch (error) {
        if (ctx.hasUI) ctx.ui.notify(`Failed to load ${agentsPath}: ${String(error)}`, "warning");
      }
    }

    if (loadedNow.length) {
      sendContextSignal("loaded", loadedNow);
    }

    if (!persistedFiles.length) return undefined;
    const details = mergePersistedContextDetails(event.details, { files: persistedFiles });
    return { details };
  });

}
