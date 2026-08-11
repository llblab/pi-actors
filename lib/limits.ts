/**
 * Shared output, preview, and Control envelope limits.
 * Zones: output governance, Trace previews, Inspect defaults, Control portability
 */

export const DEFAULT_INSPECT_LINES = 40;
export const TOOL_OUTPUT_MAX_BYTES = 50 * 1024;
export const TOOL_OUTPUT_MAX_LINES = 2_000;
export const COMPACT_PREVIEW_CHARS = 160;
export const CONTROL_ACTION_MAX_LENGTH = 64;
export const CONTROL_INPUT_MAX_BYTES = 380;
export const CONTROL_WIRE_MAX_BYTES = 512;
export const INSPECTOR_BODY_PREVIEW_CHARS = 320;
export const DOCTOR_ACTION_PREVIEW_CHARS = 72;
export const SESSION_EVIDENCE_MAX_TURNS = 100;
export const SESSION_EVIDENCE_TEXT_CHARS = 4_000;
export const SESSION_EVIDENCE_MAX_TOOL_CALLS = 100;
export const TRACE_EVENT_MAX_BYTES = 64 * 1024;
export const TRACE_EVENT_MAX_READ = 200;
