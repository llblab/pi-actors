/**
 * pi-auto-tools — persistent self-registered agent tools.
 *
 * Wraps local scripts/programs as callable pi tools and stores their
 * definitions in auto-tools.json across reloads and sessions.
 */

import type {
  ExtensionAPI,
  ExtensionContext,
} from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";
import {
  accessSync,
  closeSync,
  constants,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

interface RegisteredTool {
  name: string;
  label: string;
  description: string;
  script: string;
  args: string[];
}

interface ScriptInvocation {
  command: string;
  args: string[];
}

interface FormattedOutput {
  text: string;
  truncated: boolean;
  fullOutputPath?: string;
}

interface LoadConfigResult {
  tools: Map<string, RegisteredTool>;
  warnings: string[];
  changed: boolean;
}

interface RegisterToolInput {
  name: string;
  label?: string;
  description?: string;
  script?: string | null;
  args?: string;
  update?: boolean;
}

const AGENT_DIR = process.env.PI_CODING_AGENT_DIR
  ? resolve(process.env.PI_CODING_AGENT_DIR)
  : join(homedir(), ".pi", "agent");
const CONFIG_PATH = join(AGENT_DIR, "auto-tools.json");
const TOOL_TIMEOUT_MS = 120_000;
const MAX_OUTPUT_BYTES = 50 * 1024;
const MAX_OUTPUT_LINES = 2_000;
const RESERVED_TOOL_NAMES = new Set([
  "bash",
  "edit",
  "find",
  "grep",
  "ls",
  "read",
  "register_tool",
  "write",
]);

function expandPath(path: string, cwd = process.cwd()): string {
  const trimmed = path.trim();
  if (trimmed === "~") return homedir();
  if (trimmed.startsWith("~/")) return resolve(homedir(), trimmed.slice(2));
  return resolve(cwd, trimmed);
}

function normalizeIdentifier(value: string, prefix: string): string {
  let name = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
  if (!name) return "";
  if (/^[0-9]/.test(name)) name = `${prefix}_${name}`;
  return name.slice(0, 64).replace(/_+$/g, "");
}

function normalizeToolName(value: string): string {
  return normalizeIdentifier(value, "tool");
}

function normalizeArgName(value: string): string {
  return normalizeIdentifier(value, "arg");
}

function parseArgs(value: string): { args: string[]; error?: string } {
  const args = value
    .split(",")
    .map((arg) => normalizeArgName(arg))
    .filter(Boolean);
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const arg of args) {
    if (seen.has(arg)) duplicates.add(arg);
    seen.add(arg);
  }
  if (duplicates.size > 0)
    return {
      args: [],
      error: `Duplicate argument name(s): ${[...duplicates].join(", ")}`,
    };
  return { args };
}

function normalizeStoredArgs(value: unknown): string[] {
  const source = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(",")
      : [];
  const seen = new Set<string>();
  const args: string[] = [];
  for (const item of source) {
    const arg = normalizeArgName(String(item));
    if (!arg || seen.has(arg)) continue;
    seen.add(arg);
    args.push(arg);
  }
  return args;
}

function formatToolText(text: string): string {
  return `\n${text.replace(/^\n+/, "")}`;
}

function formatArgs(args: string[]): string {
  return args.length > 0 ? args.join(", ") : "none";
}

function textContent(text: string) {
  return { type: "text" as const, text };
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sanitizeFilePart(value: string): string {
  return normalizeIdentifier(value, "tool") || "tool";
}

function readFirstLine(path: string, maxBytes = 512): string {
  const fd = openSync(path, "r");
  try {
    const buffer = Buffer.alloc(maxBytes);
    const bytes = readSync(fd, buffer, 0, maxBytes, 0);
    return buffer.toString("utf8", 0, bytes).split(/\r?\n/, 1)[0] ?? "";
  } finally {
    closeSync(fd);
  }
}

function readShebang(path: string): string | undefined {
  const firstLine = readFirstLine(path);
  return firstLine.startsWith("#!") ? firstLine.slice(2).trim() : undefined;
}

function splitShellWords(input: string): string[] {
  const words: string[] = [];
  let current = "";
  let quote: "'" | '"' | undefined;
  let escaped = false;
  let active = false;
  for (const char of input) {
    if (escaped) {
      current += char;
      escaped = false;
      active = true;
      continue;
    }
    if (char === "\\" && quote !== "'") {
      escaped = true;
      active = true;
      continue;
    }
    if (quote) {
      if (char === quote) quote = undefined;
      else current += char;
      active = true;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      active = true;
      continue;
    }
    if (/\s/.test(char)) {
      if (active) words.push(current);
      if (active) current = "";
      active = false;
      continue;
    }
    current += char;
    active = true;
  }
  if (escaped) current += "\\";
  if (active || current) words.push(current);
  return words;
}

function isEnvCommand(command: string): boolean {
  return command.split("/").pop() === "env";
}

function parseEnvInvocation(args: string[]): ScriptInvocation | undefined {
  if (args[0] === "-S") {
    const parts = splitShellWords(args.slice(1).join(" "));
    const command = parts[0];
    return command ? { command, args: parts.slice(1) } : undefined;
  }
  let index = 0;
  while (index < args.length) {
    const arg = args[index];
    if (arg === "--") {
      index += 1;
      break;
    }
    if (["-u", "--unset", "-C", "--chdir"].includes(arg)) {
      index += 2;
      continue;
    }
    if (arg.startsWith("-") || /^[A-Za-z_][A-Za-z0-9_]*=/.test(arg)) {
      index += 1;
      continue;
    }
    break;
  }
  const command = args[index];
  return command ? { command, args: args.slice(index + 1) } : undefined;
}

function parseShebang(shebang: string): ScriptInvocation | undefined {
  const parts = splitShellWords(shebang);
  const command = parts[0];
  if (!command) return undefined;
  if (isEnvCommand(command)) return parseEnvInvocation(parts.slice(1));
  return { command, args: parts.slice(1) };
}

function validateScriptPath(scriptPath: string): string | undefined {
  try {
    const stat = statSync(scriptPath);
    if (!stat.isFile()) return `Script is not a file: ${scriptPath}`;
    const shebang = readShebang(scriptPath);
    if (shebang && !parseShebang(shebang))
      return `Unsupported shebang in script: ${scriptPath}`;
    if (!shebang) accessSync(scriptPath, constants.X_OK);
    return undefined;
  } catch (error) {
    return `Script is not readable or executable: ${scriptPath}\n${getErrorMessage(error)}`;
  }
}

function buildScriptInvocation(
  scriptPath: string,
  argValues: string[],
): ScriptInvocation {
  const shebang = readShebang(scriptPath);
  if (!shebang) return { command: scriptPath, args: argValues };
  const invocation = parseShebang(shebang);
  if (!invocation)
    throw new Error(
      formatToolText(`Unsupported shebang in script: ${scriptPath}`),
    );
  return {
    command: invocation.command,
    args: [...invocation.args, scriptPath, ...argValues],
  };
}

function writeFullOutput(
  toolName: string,
  stream: string,
  content: string,
): string | undefined {
  try {
    const dir = mkdtempSync(join(tmpdir(), "pi-auto-tools-"));
    const filePath = join(
      dir,
      `${sanitizeFilePart(toolName)}-${sanitizeFilePart(stream)}.txt`,
    );
    writeFileSync(filePath, content, "utf8");
    return filePath;
  } catch {
    return undefined;
  }
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function trimToTailBytes(value: string, maxBytes: number): string {
  const buffer = Buffer.from(value, "utf8");
  if (buffer.length <= maxBytes) return value;
  return buffer
    .subarray(buffer.length - maxBytes)
    .toString("utf8")
    .replace(/^\uFFFD+/, "");
}

function truncateTailContent(content: string): {
  content: string;
  outputBytes: number;
  outputLines: number;
  totalBytes: number;
  totalLines: number;
  truncated: boolean;
} {
  const totalBytes = byteLength(content);
  const lines = content.split("\n");
  const totalLines = lines.length;
  let output =
    totalLines > MAX_OUTPUT_LINES
      ? lines.slice(-MAX_OUTPUT_LINES).join("\n")
      : content;
  output = trimToTailBytes(output, MAX_OUTPUT_BYTES);
  const outputBytes = byteLength(output);
  const outputLines = output ? output.split("\n").length : 0;
  return {
    content: output,
    outputBytes,
    outputLines,
    totalBytes,
    totalLines,
    truncated: outputBytes < totalBytes || outputLines < totalLines,
  };
}

function formatOutput(
  toolName: string,
  stream: string,
  content: string,
): FormattedOutput {
  const body = content.trimEnd() || "(no output)";
  const truncation = truncateTailContent(body);
  if (!truncation.truncated)
    return { text: formatToolText(truncation.content), truncated: false };
  const fullOutputPath = writeFullOutput(toolName, stream, body);
  const notice = fullOutputPath
    ? `[Output truncated: ${truncation.outputLines} of ${truncation.totalLines} lines (${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)}). Full output saved to: ${fullOutputPath}]`
    : `[Output truncated: ${truncation.outputLines} of ${truncation.totalLines} lines (${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)}). Full output could not be saved.]`;
  return {
    text: formatToolText(`${truncation.content}\n\n${notice}`),
    truncated: true,
    fullOutputPath,
  };
}

function formatFailureOutput(
  toolName: string,
  code: number,
  killed: boolean,
  stdout: string,
  stderr: string,
): FormattedOutput {
  const parts = [`Exit code ${code}${killed ? " (killed)" : ""}`];
  if (stderr.trim()) parts.push(`stderr:\n${stderr.trimEnd()}`);
  if (stdout.trim()) parts.push(`stdout:\n${stdout.trimEnd()}`);
  return formatOutput(toolName, "error", parts.join("\n\n"));
}

function serializeTools(
  source: Map<string, RegisteredTool>,
): Record<string, RegisteredTool> {
  const entries = [...source.entries()].sort(([a], [b]) => a.localeCompare(b));
  const result: Record<string, RegisteredTool> = {};
  for (const [name, cfg] of entries) result[name] = cfg;
  return result;
}

function writeJsonAtomic(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const tempPath = `${path}.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFileSync(tempPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    renameSync(tempPath, path);
  } catch (error) {
    try {
      unlinkSync(tempPath);
    } catch {
      /* best effort */
    }
    throw error;
  }
}

function saveTools(source: Map<string, RegisteredTool>): string | undefined {
  try {
    writeJsonAtomic(CONFIG_PATH, serializeTools(source));
    return undefined;
  } catch (error) {
    return getErrorMessage(error);
  }
}

function getStoredEntries(raw: unknown): Array<[string | undefined, unknown]> {
  if (Array.isArray(raw)) return raw.map((value) => [undefined, value]);
  if (raw && typeof raw === "object")
    return Object.entries(raw as Record<string, unknown>);
  return [];
}

function normalizeStoredTool(
  key: string | undefined,
  value: unknown,
): { cfg?: RegisteredTool; changed: boolean; warning?: string } {
  if (!value || typeof value !== "object")
    return {
      changed: true,
      warning: `Invalid tool entry: ${key ?? "<array item>"}`,
    };
  const record = value as Record<string, unknown>;
  const rawName = typeof record.name === "string" ? record.name : (key ?? "");
  const name = normalizeToolName(rawName);
  if (!name)
    return {
      changed: true,
      warning: `Invalid tool name: ${rawName || key || "<empty>"}`,
    };
  if (RESERVED_TOOL_NAMES.has(name))
    return { changed: true, warning: `Reserved tool name skipped: ${name}` };
  const rawScript =
    typeof record.script === "string" ? record.script.trim() : "";
  if (!rawScript)
    return { changed: true, warning: `Tool "${name}" has no script path` };
  const expandedScript = expandPath(rawScript);
  const script = existsSync(expandedScript) ? expandedScript : rawScript;
  const label =
    typeof record.label === "string" && record.label.trim()
      ? record.label.trim()
      : name;
  const description =
    typeof record.description === "string" && record.description.trim()
      ? record.description.trim()
      : `Execute script: ${script}`;
  const args = normalizeStoredArgs(record.args);
  const cfg = { name, label, description, script, args };
  const changed =
    record.name !== name ||
    script !== rawScript ||
    label !== record.label ||
    description !== record.description ||
    JSON.stringify(args) !== JSON.stringify(record.args ?? []);
  return { cfg, changed };
}

function loadToolConfig(): LoadConfigResult {
  const warnings: string[] = [];
  const tools = new Map<string, RegisteredTool>();
  let changed = false;
  if (!existsSync(CONFIG_PATH)) return { tools, warnings, changed };
  try {
    const raw = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
    const entries = getStoredEntries(raw);
    for (const [key, value] of entries) {
      const result = normalizeStoredTool(key, value);
      changed = changed || result.changed;
      if (result.warning) warnings.push(result.warning);
      if (!result.cfg) continue;
      if (tools.has(result.cfg.name))
        warnings.push(
          `Duplicate tool kept from last entry: ${result.cfg.name}`,
        );
      if (tools.has(result.cfg.name)) changed = true;
      tools.set(result.cfg.name, result.cfg);
    }
    if (entries.length === 0 && raw && typeof raw !== "object")
      warnings.push(`Invalid ${CONFIG_PATH} format`);
    if (entries.length === 0 && raw && typeof raw !== "object") changed = true;
    return { tools, warnings, changed };
  } catch (error) {
    return {
      tools,
      warnings: [`Failed to load ${CONFIG_PATH}: ${getErrorMessage(error)}`],
      changed: false,
    };
  }
}

export default function toolRegistryExtension(pi: ExtensionAPI) {
  const tools = new Map<string, RegisteredTool>();
  const runtimeTools = new Set<string>();
  function notify(
    ctx: {
      hasUI: boolean;
      ui: {
        notify(message: string, type?: "info" | "warning" | "error"): void;
      };
    },
    message: string,
    type: "info" | "warning" | "error",
  ) {
    if (ctx.hasUI) ctx.ui.notify(message, type);
  }
  function getExternalToolConflict(name: string): string | undefined {
    if (runtimeTools.has(name)) return undefined;
    const existing = pi.getAllTools().find((tool) => tool.name === name);
    return existing
      ? `Tool "${name}" is already registered outside pi-auto-tools.`
      : undefined;
  }
  function registerRuntimeTool(cfg: RegisteredTool) {
    const paramSchema: Record<string, ReturnType<typeof Type.String>> = {};
    for (const arg of cfg.args)
      paramSchema[arg] = Type.String({ description: `Argument: ${arg}` });
    pi.registerTool({
      name: cfg.name,
      label: cfg.label || cfg.name,
      description: cfg.description,
      parameters: Type.Object(paramSchema),
      promptSnippet: `Execute script: ${cfg.script}`,
      async execute(_toolCallId, params, signal, _onUpdate, ctx) {
        const scriptPath = expandPath(cfg.script, ctx.cwd);
        const validationError = validateScriptPath(scriptPath);
        if (validationError) throw new Error(formatToolText(validationError));
        const argValues = cfg.args.map((arg) =>
          String((params as Record<string, unknown>)[arg] ?? ""),
        );
        const invocation = buildScriptInvocation(scriptPath, argValues);
        const result = await pi.exec(invocation.command, invocation.args, {
          cwd: ctx.cwd,
          signal,
          timeout: TOOL_TIMEOUT_MS,
        });
        if (result.code !== 0) {
          const formatted = formatFailureOutput(
            cfg.name,
            result.code,
            result.killed,
            result.stdout,
            result.stderr,
          );
          throw new Error(formatted.text);
        }
        const formatted = formatOutput(cfg.name, "stdout", result.stdout);
        return {
          content: [textContent(formatted.text)],
          details: {
            code: result.code,
            fullOutputPath: formatted.fullOutputPath,
            killed: result.killed,
            script: scriptPath,
            tool: cfg.name,
            truncated: formatted.truncated,
          },
        };
      },
    });
    runtimeTools.add(cfg.name);
  }
  function loadTools(ctx: ExtensionContext) {
    const loaded = loadToolConfig();
    tools.clear();
    for (const [name, cfg] of loaded.tools) tools.set(name, cfg);
    if (loaded.changed) {
      const saveError = saveTools(tools);
      if (saveError)
        loaded.warnings.push(
          `Failed to normalize ${CONFIG_PATH}: ${saveError}`,
        );
    }
    for (const cfg of tools.values()) {
      const conflict = getExternalToolConflict(cfg.name);
      const scriptPath = expandPath(cfg.script, ctx.cwd);
      const validationError = validateScriptPath(scriptPath);
      if (conflict) {
        loaded.warnings.push(conflict);
        continue;
      }
      if (validationError) {
        loaded.warnings.push(`Tool "${cfg.name}" skipped: ${validationError}`);
        continue;
      }
      registerRuntimeTool(cfg);
    }
    if (loaded.warnings.length > 0)
      notify(ctx, `Auto-tools: ${loaded.warnings.join("; ")}`, "warning");
  }
  function deleteTool(name: string, ctx: ExtensionContext) {
    if (!tools.has(name)) {
      return {
        content: [textContent(formatToolText(`Tool "${name}" not found.`))],
        details: { tool: name },
      };
    }
    const nextTools = new Map(tools);
    nextTools.delete(name);
    const saveError = saveTools(nextTools);
    if (saveError)
      throw new Error(
        formatToolText(`Failed to persist tool deletion: ${saveError}`),
      );
    tools.delete(name);
    pi.setActiveTools(
      pi.getActiveTools().filter((toolName) => toolName !== name),
    );
    notify(ctx, `Deleted tool: ${name}`, "info");
    return {
      content: [
        textContent(
          formatToolText(
            `Deleted tool "${name}". Reload to remove it from the complete registry.`,
          ),
        ),
      ],
      details: { config: CONFIG_PATH, tool: name },
    };
  }
  pi.on("session_start", (_event, ctx) => loadTools(ctx));
  pi.registerTool({
    name: "register_tool",
    label: "Register Tool",
    description:
      "Register a persistent custom tool by wrapping a local script/program. " +
      "Definitions are stored in auto-tools.json across reloads. " +
      "Use update=true to overwrite an existing auto-tool, script=null/empty to delete.",
    promptSnippet:
      "Register persistent external scripts as agent-callable tools",
    promptGuidelines: [
      "Use register_tool to wrap trusted local scripts, programs, or libraries as persistent pi tools.",
      "After register_tool succeeds, the new tool is immediately callable and remains available after reload.",
      'Set script=null or script="" in register_tool to delete a persisted auto-tool.',
      "Set update=true in register_tool to overwrite an existing auto-tool registration.",
    ],
    parameters: Type.Object({
      name: Type.String({
        description: "Tool name in snake_case (e.g., 'transcribe')",
      }),
      label: Type.Optional(
        Type.String({
          description: "Human-readable label (e.g., 'Transcribe Audio')",
        }),
      ),
      description: Type.Optional(
        Type.String({
          description:
            "Describe what the tool does for the LLM. Required unless deleting; omitted updates keep the old description.",
        }),
      ),
      script: Type.Optional(
        Type.Union([
          Type.String({
            description:
              "Path to the script/program. Omitted updates keep the old script. Empty string deletes the tool. Supports ~ and project-relative paths.",
          }),
          Type.Null({
            description: "Delete the tool when script is null.",
          }),
        ]),
      ),
      args: Type.Optional(
        Type.String({
          description:
            "Comma-separated argument names. Omitted updates keep old args; empty string clears args. Example: file,lang",
        }),
      ),
      update: Type.Optional(
        Type.Boolean({
          description:
            "Set to true to overwrite an existing auto-tool registration.",
        }),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const input = params as RegisterToolInput;
      const name = normalizeToolName(input.name);
      if (!name) throw new Error(formatToolText("Invalid tool name."));
      if (RESERVED_TOOL_NAMES.has(name))
        throw new Error(formatToolText(`Reserved tool name: ${name}`));
      const scriptProvided = Object.hasOwn(input, "script");
      const script =
        typeof input.script === "string" ? input.script.trim() : input.script;
      if (scriptProvided && !script) return deleteTool(name, ctx);
      const existing = tools.get(name);
      const conflict = getExternalToolConflict(name);
      if (conflict) throw new Error(formatToolText(conflict));
      if (existing && !input.update)
        throw new Error(
          formatToolText(
            `Tool "${name}" already registered. Use update=true to overwrite.`,
          ),
        );
      if (!script && !existing)
        throw new Error(formatToolText("Tool script is required for new registrations."));
      const scriptPath = script ? expandPath(script, ctx.cwd) : existing!.script;
      const validationError = validateScriptPath(scriptPath);
      if (validationError) throw new Error(formatToolText(validationError));
      const parsedArgs =
        input.args === undefined
          ? { args: existing?.args ?? [] }
          : parseArgs(input.args);
      if (parsedArgs.error) throw new Error(formatToolText(parsedArgs.error));
      const description = (
        input.description ??
        existing?.description ??
        ""
      ).trim();
      if (!description)
        throw new Error(
          formatToolText("Tool description is required unless deleting."),
        );
      const cfg: RegisteredTool = {
        name,
        label: input.label?.trim() || existing?.label || name,
        description,
        script: scriptPath,
        args: parsedArgs.args,
      };
      const nextTools = new Map(tools);
      nextTools.set(name, cfg);
      const saveError = saveTools(nextTools);
      if (saveError)
        throw new Error(
          formatToolText(`Failed to persist tool registration: ${saveError}`),
        );
      tools.set(name, cfg);
      registerRuntimeTool(cfg);
      notify(ctx, `Tool persisted: ${name}`, "info");
      return {
        content: [
          textContent(
            formatToolText(
              `${existing ? "Updated" : "Registered"} tool "${name}" (args: ${formatArgs(cfg.args)}).`,
            ),
          ),
        ],
        details: {
          args: cfg.args,
          config: CONFIG_PATH,
          script: scriptPath,
          tool: name,
        },
      };
    },
  });
}
