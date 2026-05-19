/**
 * Actor message protocol helpers.
 * Zones: 0.10 draft communication protocol, addressed messages, mailbox metadata
 * Owns pure validation/normalization for the semantic message envelope; transport routing stays in adapters.
 */

export type ActorAddressKind =
  | "branch"
  | "coordinator"
  | "run"
  | "session"
  | "tool";

export interface ActorAddress {
  kind: ActorAddressKind;
  value?: string;
  branch?: string;
}

export interface ActorMessage {
  to: string;
  type: string;
  body?: unknown;
  correlation_id?: string;
  from?: string;
  metadata?: Record<string, unknown>;
  reply_to?: string;
  summary?: string;
}

const ADDRESS_PATTERN = /^[A-Za-z0-9_.-]+$/;
const MESSAGE_TYPE_PATTERN = /^[A-Za-z][A-Za-z0-9_.:-]*$/;

function assertToken(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${label} is required`);
  if (!ADDRESS_PATTERN.test(normalized)) {
    throw new Error(`${label} contains unsupported characters: ${value}`);
  }
  return normalized;
}

export function parseActorAddress(address: string): ActorAddress {
  const value = address.trim();
  if (value === "coordinator") return { kind: "coordinator" };
  const separator = value.indexOf(":");
  if (separator < 0) throw new Error(`Actor address must include kind: ${address}`);
  const kind = value.slice(0, separator) as ActorAddressKind;
  const rest = value.slice(separator + 1);
  switch (kind) {
    case "branch": {
      const [run, branch, ...extra] = rest.split("/");
      if (extra.length > 0) throw new Error(`Branch address has too many parts: ${address}`);
      return {
        kind,
        value: assertToken(run || "", "branch run"),
        branch: assertToken(branch || "", "branch id"),
      };
    }
    case "run":
    case "session":
    case "tool":
      return { kind, value: assertToken(rest, `${kind} address`) };
    default:
      throw new Error(`Unsupported actor address kind: ${kind}`);
  }
}

export function formatActorAddress(address: ActorAddress): string {
  if (address.kind === "coordinator") return "coordinator";
  if (address.kind === "branch") {
    return `branch:${assertToken(address.value || "", "branch run")}/${assertToken(address.branch || "", "branch id")}`;
  }
  return `${address.kind}:${assertToken(address.value || "", `${address.kind} address`)}`;
}

function normalizeOptionalString(value: unknown, label: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw new Error(`${label} must be a string`);
  const normalized = value.trim();
  return normalized || undefined;
}

function normalizeMetadata(value: unknown): Record<string, unknown> | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error("message metadata must be an object");
  }
  return value as Record<string, unknown>;
}

export function normalizeActorMessage(input: unknown): ActorMessage {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("actor message must be an object");
  }
  const record = input as Record<string, unknown>;
  const to = normalizeOptionalString(record.to, "message.to");
  if (!to) throw new Error("message.to is required");
  const parsedTo = parseActorAddress(to);
  const type = normalizeOptionalString(record.type, "message.type");
  if (!type) throw new Error("message.type is required");
  if (!MESSAGE_TYPE_PATTERN.test(type)) {
    throw new Error(`message.type contains unsupported characters: ${type}`);
  }
  const from = normalizeOptionalString(record.from, "message.from");
  if (from) parseActorAddress(from);
  const normalizedTo = formatActorAddress(parsedTo);
  return {
    to: normalizedTo,
    type,
    ...(record.body !== undefined ? { body: record.body } : {}),
    ...(record.correlation_id !== undefined
      ? { correlation_id: String(record.correlation_id) }
      : {}),
    ...(from ? { from: formatActorAddress(parseActorAddress(from)) } : {}),
    ...(record.metadata !== undefined ? { metadata: normalizeMetadata(record.metadata) } : {}),
    ...(record.reply_to !== undefined ? { reply_to: String(record.reply_to) } : {}),
    ...(record.summary !== undefined ? { summary: String(record.summary) } : {}),
  };
}
