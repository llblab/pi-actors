/**
 * Async run outbox events.
 * Owns outbox event normalization, parsing, and append payload formatting.
 */

export type RunOutboxDelivery = "log" | "notify" | "followup";
export type RunOutboxLevel = "info" | "warning" | "error";

export interface RunOutboxEvent {
  body?: unknown;
  correlation_id?: string;
  data?: unknown;
  delivery: RunOutboxDelivery;
  event: string;
  from?: string;
  id: string;
  level: RunOutboxLevel;
  metadata?: Record<string, unknown>;
  reply_to?: string;
  run: string;
  state_dir: string;
  summary: string;
  to?: string;
  ts: string;
  type?: string;
}

export function normalizeRunOutboxDelivery(value: unknown): RunOutboxDelivery {
  return value === "notify" || value === "followup" ? value : "log";
}

export function normalizeRunOutboxLevel(value: unknown): RunOutboxLevel {
  return value === "warning" || value === "error" ? value : "info";
}

function normalizeRunOutboxEvent(
  raw: unknown,
  run: string,
  stateDir: string,
  index: number,
): RunOutboxEvent | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const record = raw as Record<string, unknown>;
  const event =
    typeof record.event === "string" && record.event.trim()
      ? record.event.trim()
      : "run.event";
  const summary =
    typeof record.summary === "string" && record.summary.trim()
      ? record.summary.trim()
      : event;
  const ts =
    typeof record.ts === "string" && record.ts.trim()
      ? record.ts.trim()
      : new Date(0).toISOString();
  const id =
    typeof record.id === "string" && record.id.trim()
      ? record.id.trim()
      : `${run}:${index}`;
  return {
    ...(record.body !== undefined ? { body: record.body } : {}),
    ...(typeof record.correlation_id === "string"
      ? { correlation_id: record.correlation_id }
      : {}),
    ...(record.data !== undefined ? { data: record.data } : {}),
    delivery: normalizeRunOutboxDelivery(record.delivery),
    ...(record.metadata &&
    typeof record.metadata === "object" &&
    !Array.isArray(record.metadata)
      ? { metadata: record.metadata as Record<string, unknown> }
      : {}),
    event,
    ...(typeof record.from === "string" ? { from: record.from } : {}),
    id,
    level: normalizeRunOutboxLevel(record.level),
    ...(typeof record.reply_to === "string"
      ? { reply_to: record.reply_to }
      : {}),
    run,
    state_dir: stateDir,
    summary,
    ...(typeof record.to === "string" ? { to: record.to } : {}),
    ts,
    ...(typeof record.type === "string" ? { type: record.type } : {}),
  };
}

export function parseRunOutboxEventLine(
  line: string,
  run: string,
  stateDir: string,
  index: number,
): RunOutboxEvent | undefined {
  try {
    return normalizeRunOutboxEvent(JSON.parse(line), run, stateDir, index);
  } catch {
    return undefined;
  }
}

export function buildRunOutboxEventPayload(
  run: string,
  event: {
    body?: unknown;
    correlation_id?: string;
    data?: unknown;
    delivery?: string;
    event?: string;
    from?: string;
    level?: string;
    metadata?: Record<string, unknown>;
    reply_to?: string;
    summary?: string;
    to?: string;
    type?: string;
  },
): Record<string, unknown> {
  const type = event.type || event.event || "run.message";
  const to = event.to || "coordinator";
  const metadata = event.metadata ?? {};
  const requiresResponse = metadata.requires_response === true;
  return {
    ...(event.body !== undefined ? { body: event.body } : {}),
    ...(event.correlation_id ? { correlation_id: event.correlation_id } : {}),
    ...(event.data !== undefined ? { data: event.data } : {}),
    delivery: normalizeRunOutboxDelivery(
      event.delivery ??
        (requiresResponse
          ? "followup"
          : to === "coordinator"
            ? "notify"
            : "log"),
    ),
    event: type,
    from: event.from || `run:${run}`,
    level: normalizeRunOutboxLevel(event.level),
    ...(event.metadata ? { metadata: event.metadata } : {}),
    ...(event.reply_to ? { reply_to: event.reply_to } : {}),
    summary: event.summary || type,
    to,
    ts: new Date().toISOString(),
    type,
  };
}
