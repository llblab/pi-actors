/**
 * Public tool mailbox contract helpers
 * Zones: accepted/emitted message type declarations, contract normalization, compact type extraction
 * Owns mailbox metadata normalization for public message and inspect tool paths
 */

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function normalizeMailboxEntry(
  value: unknown,
): Record<string, unknown> | undefined {
  if (typeof value === "string") return { type: value };
  const record = asRecord(value);
  if (typeof record.type !== "string" || !record.type.trim()) return undefined;
  return {
    type: record.type.trim(),
    ...(record.body_schema !== undefined
      ? { body_schema: record.body_schema }
      : {}),
    ...(record.ack !== undefined ? { ack: record.ack } : {}),
    ...(typeof record.idempotency === "string"
      ? { idempotency: record.idempotency }
      : {}),
    ...(typeof record.level === "string" ? { level: record.level } : {}),
    ...(record.requires_response === true ? { requires_response: true } : {}),
    ...(typeof record.summary === "string" ? { summary: record.summary } : {}),
  };
}

export function normalizeMailboxContracts(
  mailbox: Record<string, unknown>,
): Record<string, unknown[]> {
  const accepts = Array.isArray(mailbox.accepts)
    ? mailbox.accepts
        .map(normalizeMailboxEntry)
        .filter((entry): entry is Record<string, unknown> => Boolean(entry))
    : [];
  const emits = Array.isArray(mailbox.emits)
    ? mailbox.emits
        .map(normalizeMailboxEntry)
        .filter((entry): entry is Record<string, unknown> => Boolean(entry))
    : [];
  return { accepts, emits };
}

export function mailboxTypes(entries: unknown[]): string[] {
  return entries.flatMap((entry) =>
    typeof asRecord(entry).type === "string"
      ? [String(asRecord(entry).type)]
      : [],
  );
}
