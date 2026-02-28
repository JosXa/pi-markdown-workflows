import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { normalizeAtPrefix } from "./workflow.js";

const SUBDIR_CONTEXT_MESSAGE_TYPE = "subdir-context-autoload";

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

function isDiscoveryBashCommand(value: string): boolean {
  const lower = value.trim().toLowerCase();
  if (!lower) return false;
  const command = lower.split(/\s+/)[0] ?? "";
  const names = new Set(["ls", "find", "rg", "grep", "fd", "tree", "git"]);
  if (command !== "git") return names.has(command);
  const parts = lower.split(/\s+/);
  const subcommand = parts[1] ?? "";
  return subcommand === "ls-files" || subcommand === "grep";
}

function bashTargets(value: string, base: string): string[] {
  const parts = value
    .split(/\s+/)
    .map((item) => item.trim().replace(/^['"]+|['"]+$/g, ""))
    .filter(Boolean);
  if (!parts.length) return [base];
  const paths: string[] = [];
  for (let index = 1; index < parts.length; index += 1) {
    const item = parts[index];
    if (!item) continue;
    if (item.startsWith("-")) continue;
    if (item === "|" || item === "&&" || item === ";") continue;
    if (item.includes("=")) continue;
    if (item === ".") {
      paths.push(base);
      continue;
    }
    if (item.startsWith("/")) {
      paths.push(resolvePath(item, base));
      continue;
    }
    if (item.startsWith("./") || item.startsWith("../") || item.includes("/")) {
      paths.push(resolvePath(item, base));
    }
  }
  if (!paths.length) return [base];
  return paths;
}

export function registerSubdirContextAutoload(pi: ExtensionAPI): void {
  const loadedAgents = new Set<string>();
  const loadedAgentsContent = new Map<string, string>();
  let currentCwd = "";
  let cwdAgentsPath = "";
  let homeDir = "";
  let readCount = 0;

  function resetSession(cwd: string): void {
    currentCwd = resolvePath(cwd, process.cwd());
    cwdAgentsPath = path.join(currentCwd, "AGENTS.md");
    homeDir = resolvePath(os.homedir(), process.cwd());
    readCount = 0;
    loadedAgents.clear();
    loadedAgentsContent.clear();
    loadedAgents.add(cwdAgentsPath);
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

  function relativePath(absolutePath: string): string {
    const relative = currentCwd ? path.relative(currentCwd, absolutePath) : absolutePath;
    return (relative || absolutePath).replaceAll("\\", "/");
  }

  function buildInjectedContextMessage() {
    if (!loadedAgentsContent.size) return null;
    const files = [...loadedAgentsContent.entries()].sort(([a], [b]) => a.localeCompare(b));
    const body = files
      .map(([agentsPath, content]) => {
        const rel = relativePath(agentsPath);
        return `<agents_file path="${rel}">\n${content}\n</agents_file>`;
      })
      .join("\n\n");
    return {
      role: "custom" as const,
      customType: SUBDIR_CONTEXT_MESSAGE_TYPE,
      content: [
        "<subdirectory_agents_context>",
        "Automatically loaded AGENTS.md context relevant to recently accessed files.",
        body,
        "</subdirectory_agents_context>",
      ].join("\n"),
      display: false,
      details: {
        files: files.map(([agentsPath]) => relativePath(agentsPath)),
      },
      timestamp: Date.now(),
    };
  }

  const handleSessionChange = (_event: unknown, ctx: ExtensionContext): void => {
    resetSession(ctx.cwd);
  };

  pi.on("session_start", handleSessionChange);
  pi.on("session_switch", handleSessionChange);

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
    if (!currentCwd) resetSession(ctx.cwd);

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
      const searchRoot = isInsideRoot(currentCwd, target)
        ? currentCwd
        : isInsideRoot(homeDir, target)
          ? homeDir
          : "";
      if (!searchRoot) continue;
      if (path.basename(target) === "AGENTS.md") {
        loadedAgents.add(path.normalize(target));
        continue;
      }
      const probe =
        fs.existsSync(target) && fs.statSync(target).isDirectory()
          ? path.join(target, "__probe__")
          : target;
      const files = findAgentsFiles(probe, searchRoot);
      for (const file of files) paths.add(file);
    }

    const agentFiles = [...paths];
    if (!agentFiles.length) return undefined;
    const hasFresh = agentFiles.some((agentsPath) => !loadedAgents.has(agentsPath));
    const shouldRefresh = readCount % 10 === 0;
    if (!hasFresh && !shouldRefresh) return undefined;

    const loadedNow: string[] = [];

    for (const agentsPath of agentFiles) {
      try {
        const content = await fs.promises.readFile(agentsPath, "utf-8");
        const wasLoaded = loadedAgents.has(agentsPath);
        loadedAgents.add(agentsPath);
        loadedAgentsContent.set(agentsPath, content);
        if (!wasLoaded) loadedNow.push(relativePath(agentsPath));
      } catch (error) {
        if (ctx.hasUI) ctx.ui.notify(`Failed to load ${agentsPath}: ${String(error)}`, "warning");
      }
    }

    if (loadedNow.length && ctx.hasUI) {
      const label =
        loadedNow.length === 1
          ? `Loaded AGENTS.md context: ${loadedNow[0]}`
          : `Loaded AGENTS.md context (${loadedNow.length} files)`;
      ctx.ui.notify(label, "info");
    }

    return undefined;
  });

  pi.on("context", async (event) => {
    const injected = buildInjectedContextMessage();
    if (!injected) return undefined;
    const baseMessages = Array.isArray(event.messages) ? event.messages : [];
    const messages = baseMessages.filter((message) => {
      return !(
        message &&
        typeof message === "object" &&
        "role" in message &&
        message.role === "custom" &&
        "customType" in message &&
        message.customType === SUBDIR_CONTEXT_MESSAGE_TYPE
      );
    });
    return { messages: [...messages, injected] };
  });
}
