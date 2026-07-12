/**
 * Persisted Pi session evidence reader.
 * Zones: subagent turns, active session branches, bounded/redacted previews
 * Owns read-only normalization of session JSONL into inspector-ready turns.
 */

import * as Limits from "./limits.ts";
import {
  readJsonlFileResilient,
  type StateReadDiagnostic,
} from "./state-readers.ts";

interface SessionEntry {
  id?: unknown;
  message?: unknown;
  parentId?: unknown;
  timestamp?: unknown;
  type?: unknown;
  [key: string]: unknown;
}

export interface SessionEvidenceToolCall {
  arguments?: unknown;
  id: string;
  name: string;
  result?: unknown;
  resultError?: boolean;
}

export interface SessionEvidenceTurn {
  assistantEntryId?: string;
  assistantText?: string;
  error?: string;
  index: number;
  model?: string;
  provider?: string;
  stopReason?: string;
  thinking?: string;
  timestamp?: string;
  toolCalls: SessionEvidenceToolCall[];
  unmatchedToolResults: number;
  usage?: unknown;
  userEntryId?: string;
  userText?: string;
}

export interface SessionEvidence {
  activeLeafId?: string;
  diagnostics: StateReadDiagnostic[];
  path: string;
  session?: Record<string, unknown>;
  totalTurns: number;
  truncated: boolean;
  turns: SessionEvidenceTurn[];
}

export interface SessionEvidenceReadOptions {
  maxTextChars?: number;
  maxToolCalls?: number;
  maxTurns?: number;
}

const SENSITIVE_KEY = /(?:^|[_-])(?:api[-_]?key|authorization|cookie|credential|password|private[-_]?key|secret|secret[-_]?access[-_]?key|token)$|^(?:access|refresh|auth|api)Token$|^(?:clientSecret|privateKey|secretAccessKey)$/i;
const SENSITIVE_TEXT = /(bearer\s+)[A-Za-z0-9._~+/=-]+|["']?\b(api[-_]?key|authorization|clientSecret|cookie|password|private[-_]?key|privateKey|secret|secretAccessKey|token)["']?(\s*[:=]\s*)["']?([^\s,;"'}]+)/gi;

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function boundedText(value: unknown, maxChars: number): string | undefined {
  if (typeof value !== "string") return undefined;
  if (/^\s*[\[{]/.test(value)) {
    try {
      const structured = JSON.stringify(
        redactSessionEvidenceValue(JSON.parse(value), maxChars),
      );
      return structured.length > maxChars
        ? `${structured.slice(0, Math.max(0, maxChars - 1))}…`
        : structured;
    } catch {
      // Fall through to bounded text redaction.
    }
  }
  const redacted = value.replaceAll(
    SENSITIVE_TEXT,
    (match, bearer: string | undefined, key: string | undefined, separator: string | undefined) =>
      bearer ? `${bearer}[REDACTED]` : `${key}${separator}[REDACTED]`,
  );
  return redacted.length > maxChars
    ? `${redacted.slice(0, Math.max(0, maxChars - 1))}…`
    : redacted;
}

export function redactSessionEvidenceValue(
  value: unknown,
  maxTextChars = Limits.SESSION_EVIDENCE_TEXT_CHARS,
  seen = new WeakSet<object>(),
): unknown {
  if (typeof value === "string") return boundedText(value, maxTextChars);
  if (!value || typeof value !== "object") return value;
  if (seen.has(value)) return "[CIRCULAR]";
  seen.add(value);
  if (Array.isArray(value)) {
    return value.map((item) => redactSessionEvidenceValue(item, maxTextChars, seen));
  }
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, item]) => [
      key,
      SENSITIVE_KEY.test(key)
        ? "[REDACTED]"
        : redactSessionEvidenceValue(item, maxTextChars, seen),
    ]),
  );
}

function contentBlocks(message: Record<string, unknown>): Record<string, unknown>[] {
  return Array.isArray(message.content)
    ? message.content.map(asRecord)
    : typeof message.content === "string"
      ? [{ type: "text", text: message.content }]
      : [];
}

function contentText(
  message: Record<string, unknown>,
  type: "text" | "thinking",
  maxChars: number,
): string | undefined {
  const text = contentBlocks(message)
    .filter((block) => block.type === type && typeof block[type] === "string")
    .map((block) => String(block[type]))
    .join("\n");
  return boundedText(text, maxChars);
}

function activeBranch(
  entries: SessionEntry[],
  path: string,
  diagnostics: StateReadDiagnostic[],
): SessionEntry[] {
  const treeEntries = entries.filter(
    (entry) => entry.type !== "session" && typeof entry.id === "string",
  );
  const leaf = treeEntries.at(-1);
  if (!leaf || typeof leaf.id !== "string") return [];
  const byId = new Map(
    treeEntries.map((entry) => [String(entry.id), entry] as const),
  );
  const branch: SessionEntry[] = [];
  const visited = new Set<string>();
  let current: SessionEntry | undefined = leaf;
  while (current && typeof current.id === "string") {
    if (visited.has(current.id)) {
      diagnostics.push({ message: `session entry cycle at ${current.id}`, path });
      break;
    }
    visited.add(current.id);
    branch.push(current);
    if (current.parentId === null || current.parentId === undefined) break;
    if (typeof current.parentId !== "string" || !byId.has(current.parentId)) {
      diagnostics.push({
        message: `missing parent ${String(current.parentId)} for ${current.id}`,
        path,
      });
      break;
    }
    current = byId.get(current.parentId);
  }
  return branch.reverse();
}

function toolCalls(
  message: Record<string, unknown>,
  maxTextChars: number,
  maxToolCalls: number,
): SessionEvidenceToolCall[] {
  return contentBlocks(message)
    .filter(
      (block) =>
        block.type === "toolCall" &&
        typeof block.id === "string" &&
        typeof block.name === "string",
    )
    .slice(0, maxToolCalls)
    .map((block) => ({
      arguments: redactSessionEvidenceValue(block.arguments, maxTextChars),
      id: String(block.id),
      name: String(block.name),
    }));
}

export function readSessionEvidence(
  path: string,
  options: SessionEvidenceReadOptions = {},
): SessionEvidence {
  const maxTextChars = Math.max(
    1,
    options.maxTextChars ?? Limits.SESSION_EVIDENCE_TEXT_CHARS,
  );
  const maxToolCalls = Math.max(
    1,
    options.maxToolCalls ?? Limits.SESSION_EVIDENCE_MAX_TOOL_CALLS,
  );
  const maxTurns = Math.max(
    1,
    options.maxTurns ?? Limits.SESSION_EVIDENCE_MAX_TURNS,
  );
  const read = readJsonlFileResilient<SessionEntry>(path);
  const diagnostics = [...read.diagnostics];
  const header = read.records.find((entry) => entry.type === "session");
  const branch = activeBranch(read.records, path, diagnostics);
  const turns: SessionEvidenceTurn[] = [];
  let pendingUser: { id: string; text?: string } | undefined;
  let currentTurn: SessionEvidenceTurn | undefined;
  for (const entry of branch) {
    if (entry.type !== "message") continue;
    const message = asRecord(entry.message);
    const role = message.role;
    if (role === "user") {
      pendingUser = {
        id: String(entry.id),
        text: contentText(message, "text", maxTextChars),
      };
      currentTurn = undefined;
      continue;
    }
    if (role === "assistant") {
      currentTurn = {
        ...(typeof entry.id === "string" ? { assistantEntryId: entry.id } : {}),
        ...(contentText(message, "text", maxTextChars)
          ? { assistantText: contentText(message, "text", maxTextChars) }
          : {}),
        ...(typeof message.errorMessage === "string"
          ? { error: boundedText(message.errorMessage, maxTextChars) }
          : {}),
        index: turns.length + 1,
        ...(typeof message.model === "string" ? { model: message.model } : {}),
        ...(typeof message.provider === "string"
          ? { provider: message.provider }
          : {}),
        ...(typeof message.stopReason === "string"
          ? { stopReason: message.stopReason }
          : {}),
        ...(contentText(message, "thinking", maxTextChars)
          ? { thinking: contentText(message, "thinking", maxTextChars) }
          : {}),
        ...(typeof entry.timestamp === "string"
          ? { timestamp: entry.timestamp }
          : {}),
        toolCalls: toolCalls(message, maxTextChars, maxToolCalls),
        unmatchedToolResults: 0,
        ...(message.usage !== undefined
          ? { usage: redactSessionEvidenceValue(message.usage, maxTextChars) }
          : {}),
        ...(pendingUser
          ? {
              userEntryId: pendingUser.id,
              ...(pendingUser.text ? { userText: pendingUser.text } : {}),
            }
          : {}),
      };
      pendingUser = undefined;
      turns.push(currentTurn);
      continue;
    }
    if (role === "toolResult" && currentTurn) {
      const callId = typeof message.toolCallId === "string" ? message.toolCallId : "";
      const call = currentTurn.toolCalls.find((item) => item.id === callId);
      if (!call) {
        currentTurn.unmatchedToolResults += 1;
        continue;
      }
      call.result = redactSessionEvidenceValue(message.content, maxTextChars);
      call.resultError = message.isError === true;
    }
  }
  if (pendingUser) {
    turns.push({
      index: turns.length + 1,
      toolCalls: [],
      unmatchedToolResults: 0,
      userEntryId: pendingUser.id,
      ...(pendingUser.text ? { userText: pendingUser.text } : {}),
    });
  }
  const firstVisibleIndex = Math.max(0, turns.length - maxTurns);
  const visibleTurns = turns.slice(firstVisibleIndex).map((turn, index) => ({
    ...turn,
    index: firstVisibleIndex + index + 1,
  }));
  return {
    ...(branch.at(-1)?.id ? { activeLeafId: String(branch.at(-1)?.id) } : {}),
    diagnostics,
    path,
    ...(header ? { session: asRecord(header) } : {}),
    totalTurns: turns.length,
    truncated: turns.length > visibleTurns.length,
    turns: visibleTurns,
  };
}
