/**
 * Model-facing Run Control projection.
 * Zones: structured redaction, bounded Control input/error, decision-useful evidence
 * Owns safe Control reads; durable journals and lifecycle transitions remain in runs-controls.
 */

import * as Limits from "./limits.ts";
import type { RunControlRecord, RunControlStatus } from "./runs-controls.ts";
import * as SessionEvidence from "./session-evidence.ts";

export interface ProjectedRunControl {
  action: string;
  claimed_at?: string;
  delivered_at?: string;
  error?: string;
  failed_at?: string;
  handled_at?: string;
  id: string;
  input?: unknown;
  queued_at: string;
  run_instance_id: string;
  status: RunControlStatus;
}

const OPTIONAL_TIMESTAMP_FIELDS = [
  "claimed_at",
  "delivered_at",
  "failed_at",
  "handled_at",
] as const;
type OptionalTimestampField = (typeof OPTIONAL_TIMESTAMP_FIELDS)[number];

function boundedRedactedString(value: string, maxChars: number): string {
  const redacted = SessionEvidence.redactSessionEvidenceValue(value, maxChars);
  return typeof redacted === "string"
    ? redacted
    : String(redacted).slice(0, maxChars);
}

function boundedRedactedValue(value: unknown): unknown {
  const redacted = SessionEvidence.redactSessionEvidenceValue(
    value,
    Limits.INSPECTOR_BODY_PREVIEW_CHARS,
  );
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(redacted);
  } catch {
    return "[UNSERIALIZABLE]";
  }
  if (serialized === undefined) return "[UNSERIALIZABLE]";
  if (serialized.length <= Limits.INSPECTOR_BODY_PREVIEW_CHARS) return redacted;
  let preview = serialized.slice(0, Limits.INSPECTOR_BODY_PREVIEW_CHARS);
  let bounded = { preview: `${preview}…`, truncated: true };
  while (
    preview &&
    JSON.stringify(bounded).length > Limits.INSPECTOR_BODY_PREVIEW_CHARS
  ) {
    const excess = JSON.stringify(bounded).length - Limits.INSPECTOR_BODY_PREVIEW_CHARS;
    preview = preview.slice(0, Math.max(0, preview.length - Math.max(1, excess)));
    bounded = { preview: `${preview}…`, truncated: true };
  }
  return bounded;
}

export function projectRunControl(
  control: RunControlRecord,
): ProjectedRunControl {
  const timestamps = Object.fromEntries(
    OPTIONAL_TIMESTAMP_FIELDS.flatMap((field) => {
      const value = control[field];
      return typeof value === "string"
        ? [[field, boundedRedactedString(value, Limits.COMPACT_PREVIEW_CHARS)] as const]
        : [];
    }),
  ) as Partial<Pick<ProjectedRunControl, OptionalTimestampField>>;
  return {
    action: boundedRedactedString(control.action, Limits.COMPACT_PREVIEW_CHARS),
    ...timestamps,
    ...(typeof control.error === "string"
      ? {
          error: boundedRedactedString(
            control.error,
            Limits.INSPECTOR_BODY_PREVIEW_CHARS,
          ),
        }
      : {}),
    id: boundedRedactedString(control.id, Limits.COMPACT_PREVIEW_CHARS),
    ...(control.input !== undefined
      ? { input: boundedRedactedValue(control.input) }
      : {}),
    queued_at: boundedRedactedString(
      control.queued_at,
      Limits.COMPACT_PREVIEW_CHARS,
    ),
    run_instance_id: boundedRedactedString(
      control.run_instance_id,
      Limits.COMPACT_PREVIEW_CHARS,
    ),
    status: boundedRedactedString(
      control.status,
      Limits.COMPACT_PREVIEW_CHARS,
    ) as RunControlStatus,
  };
}
