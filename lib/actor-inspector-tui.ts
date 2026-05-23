/**
 * Actor inspector TUI previews.
 * Zones: terminal actor inspection, room/direct message previews, no-dependency UI formatting
 */

import * as fs from "node:fs";
import * as path from "node:path";

import type { ActorMessage } from "./actor-messages.ts";
import * as Paths from "./paths.ts";

export interface ActorInspectorPreview {
  body_preview?: string;
  channel: "broadcast" | "direct" | "room";
  from?: string;
  run: string;
  sequence?: number;
  summary?: string;
  stripe?: boolean;
  timestamp: string;
  to: string;
  type: string;
}

export interface ActorInspectorWidgetStyle {
  actor?: (text: string) => string;
  muted?: (text: string) => string;
  preview?: (text: string) => string;
  stripe?: (text: string) => string;
  stripeAlt?: (text: string) => string;
  target?: (text: string) => string;
  type?: (text: string) => string;
}

export type ActorInspectorVerbosity = "compact" | "verbose";

export interface ActorInspectorRenderOptions {
  verbosity?: ActorInspectorVerbosity;
}

export interface ActorInspectorPreviewReadOptions {
  ownerId?: string;
  currentRunOnly?: boolean;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function readJsonLines(file: string): Record<string, unknown>[] {
  try {
    return fs
      .readFileSync(file, "utf8")
      .split("\n")
      .filter(Boolean)
      .flatMap((line) => {
        try {
          return [JSON.parse(line) as Record<string, unknown>];
        } catch {
          return [];
        }
      });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    return [];
  }
}

function previewValue(value: unknown, maxLength = 320): string | undefined {
  if (value === undefined) return undefined;
  const text = typeof value === "string" ? value : JSON.stringify(value);
  const compact = text.replaceAll(/\s+/g, " ").trim();
  if (!compact) return undefined;
  return compact.length > maxLength
    ? `${compact.slice(0, Math.max(0, maxLength - 1))}…`
    : compact;
}

function channelFor(message: Pick<ActorMessage, "to">): ActorInspectorPreview["channel"] {
  if (message.to.startsWith("room:")) return "room";
  if (message.to === "coordinator" || message.to.startsWith("session:")) return "broadcast";
  return "direct";
}

function previewFromMessage(
  run: string,
  message: Record<string, unknown>,
  timestamp: string,
): ActorInspectorPreview | undefined {
  const to = typeof message.to === "string" ? message.to : undefined;
  const type = typeof message.type === "string" ? message.type : undefined;
  if (!to || !type) return undefined;
  const from = typeof message.from === "string" ? message.from : undefined;
  const summary = typeof message.summary === "string" ? message.summary : undefined;
  return {
    ...(previewValue(message.body) ? { body_preview: previewValue(message.body) } : {}),
    channel: channelFor({ to }),
    ...(from ? { from } : {}),
    run,
    ...(summary ? { summary } : {}),
    timestamp,
    to,
    type,
  };
}

function readRoomPreviews(run: string, stateDir: string): ActorInspectorPreview[] {
  const roomsDir = path.join(stateDir, "rooms");
  try {
    return fs
      .readdirSync(roomsDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .flatMap((entry) =>
        readJsonLines(path.join(roomsDir, entry.name, "messages.jsonl"))
          .map((message) =>
            previewFromMessage(
              run,
              message,
              String(message.received_at ?? message.timestamp ?? ""),
            ),
          )
          .filter((preview): preview is ActorInspectorPreview => Boolean(preview)),
      );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    return [];
  }
}

function readInboxPreviews(run: string, stateDir: string): ActorInspectorPreview[] {
  return readJsonLines(path.join(stateDir, "inbox.jsonl"))
    .map((message) =>
      previewFromMessage(
        run,
        message,
        String(message.received_at ?? message.timestamp ?? ""),
      ),
    )
    .filter((preview): preview is ActorInspectorPreview => Boolean(preview));
}

function readOutboxPreviews(run: string, stateDir: string): ActorInspectorPreview[] {
  return readJsonLines(path.join(stateDir, "outbox.jsonl"))
    .map((event) => {
      const message = asRecord(event.message ?? event);
      return previewFromMessage(
        run,
        message,
        String(event.timestamp ?? event.created_at ?? event.emitted_at ?? ""),
      );
    })
    .filter((preview): preview is ActorInspectorPreview => Boolean(preview));
}

function getRunOwnerId(stateDir: string): string | undefined {
  try {
    const meta = JSON.parse(
      fs.readFileSync(path.join(stateDir, "run.json"), "utf8"),
    ) as Record<string, unknown>;
    return typeof meta.ownerId === "string" ? meta.ownerId : undefined;
  } catch {
    return undefined;
  }
}

function matchesOwner(stateDir: string, ownerId: string | undefined): boolean {
  return ownerId === undefined || getRunOwnerId(stateDir) === ownerId;
}

export function readActorInspectorPreviews(
  stateRoot = Paths.getRunStateRoot(),
  limit = 8,
  options: ActorInspectorPreviewReadOptions = {},
): ActorInspectorPreview[] {
  try {
    const previews = fs
      .readdirSync(stateRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .flatMap((entry) => {
        const stateDir = path.join(stateRoot, entry.name);
        if (!matchesOwner(stateDir, options.ownerId)) return [];
        return [
          ...readRoomPreviews(entry.name, stateDir),
          ...readInboxPreviews(entry.name, stateDir),
          ...readOutboxPreviews(entry.name, stateDir),
        ];
      })
      .filter((preview) => preview.timestamp)
      .sort((a, b) => a.timestamp.localeCompare(b.timestamp));
    const currentRun = options.currentRunOnly ? previews.at(-1)?.run : undefined;
    return previews
      .filter((preview) => !currentRun || preview.run === currentRun)
      .map((preview, index) => ({
        ...preview,
        sequence: index + 1,
        stripe: index % 2 === 0,
      }))
      .slice(-Math.max(1, limit));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    return [];
  }
}

function shorten(
  value: string | undefined,
  maxLength: number,
  options: { preserveSpaces?: boolean } = { preserveSpaces: true },
): string {
  if (!value) return "-";
  const compact = options.preserveSpaces === false
    ? value.replaceAll(/\s+/g, "_")
    : value.replaceAll(/\s+/g, " ").trim();
  if (maxLength <= 1) return compact.slice(0, Math.max(0, maxLength));
  return compact.length > maxLength
    ? `${compact.slice(0, Math.max(0, maxLength - 1))}…`
    : compact;
}

function actorName(address: string | undefined): string {
  if (!address) return "unknown";
  const branch = /^branch:[^/]+\/(.+)$/.exec(address);
  if (branch) return branch[1] || address;
  const run = /^run:(.+)$/.exec(address);
  if (run) return run[1] || address;
  return address;
}

function roomName(address: string): string | undefined {
  const room = /^room:([^/]+)(?:\/(main))?$/.exec(address);
  return room ? room[1] : undefined;
}

function routeText(preview: ActorInspectorPreview): string {
  const actor = actorName(preview.from);
  if (preview.channel === "room") return `${actor} # all`;
  if (preview.channel === "broadcast") return `${actor} ⇢ ${preview.to}`;
  return `${actor} → ${actorName(preview.to)}`;
}

function style(styleFn: ((text: string) => string) | undefined, text: string): string {
  return styleFn ? styleFn(text) : text;
}

function previewText(preview: ActorInspectorPreview): string {
  return preview.summary || preview.body_preview || "-";
}

function detailText(preview: ActorInspectorPreview): string {
  return preview.body_preview || preview.summary || "-";
}

function stripAnsi(value: string): string {
  return value.replaceAll(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
}

function charDisplayWidth(char: string): number {
  const code = char.codePointAt(0) ?? 0;
  if (code === 0) return 0;
  if (code < 32 || (code >= 0x7f && code < 0xa0)) return 0;
  if (
    code >= 0x1100 &&
    (code <= 0x115f ||
      code === 0x2329 ||
      code === 0x232a ||
      (code >= 0x2e80 && code <= 0xa4cf && code !== 0x303f) ||
      (code >= 0xac00 && code <= 0xd7a3) ||
      (code >= 0xf900 && code <= 0xfaff) ||
      (code >= 0xfe10 && code <= 0xfe19) ||
      (code >= 0xfe30 && code <= 0xfe6f) ||
      (code >= 0xff00 && code <= 0xff60) ||
      (code >= 0xffe0 && code <= 0xffe6) ||
      (code >= 0x1f300 && code <= 0x1faff))
  ) return 2;
  return 1;
}

function displayWidth(value: string): number {
  return Array.from(stripAnsi(value)).reduce((sum, char) => sum + charDisplayWidth(char), 0);
}

function boundedLine(value: string, width: number): string {
  if (displayWidth(value) <= width) return value;
  if (width <= 1) return "";
  let output = "";
  let used = 0;
  for (const char of Array.from(value)) {
    const charWidth = charDisplayWidth(char);
    if (used + charWidth > width - 2) break;
    output += char;
    used += charWidth;
  }
  return `${output}… `;
}

function padLine(plain: string, rendered: string, width: number, styles: ActorInspectorWidgetStyle): string {
  const boundedPlain = boundedLine(plain, width);
  const visible = boundedPlain === plain ? rendered : style(styles.preview, boundedPlain);
  const padding = Math.max(0, width - displayWidth(boundedPlain));
  return `${visible}${" ".repeat(padding)}`;
}

function renderCompactInspectorEntry(
  preview: ActorInspectorPreview,
  width: number,
  sequenceWidth: number,
  routeWidth: number,
  typeWidth: number,
  styles: ActorInspectorWidgetStyle,
  stripe: boolean,
): string[] {
  const separator = "  ";
  const prefix = " ";
  const contentWidth = Math.max(8, width - prefix.length);
  const sequence = String(preview.sequence ?? 0).padStart(sequenceWidth, " ");
  const sequencePrefix = `${sequence}  `;
  const route = routeText(preview);
  const routePadding = " ".repeat(Math.max(0, routeWidth - route.length));
  const typePadding = " ".repeat(Math.max(0, typeWidth - preview.type.length));
  const headline = previewText(preview);
  const lead = `${sequencePrefix}${route}${routePadding}${separator}${preview.type}${typePadding}${separator}`;
  const visibleHeadline = boundedLine(headline, Math.max(0, contentWidth - lead.length));
  const plain = `${lead}${visibleHeadline}`;
  const rendered = [
    style(styles.muted, sequencePrefix),
    style(styles.target, route),
    routePadding,
    separator,
    style(styles.type, preview.type),
    typePadding,
    separator,
    style(styles.preview, visibleHeadline),
  ].join("");
  const line = `${prefix}${padLine(plain, rendered, contentWidth, styles)}`;
  if (stripe && styles.stripe) return [styles.stripe(line)];
  if (!stripe && styles.stripeAlt) return [styles.stripeAlt(line)];
  return [line];
}

function renderVerboseInspectorEntry(
  preview: ActorInspectorPreview,
  width: number,
  sequenceWidth: number,
  labelWidth: number,
  styles: ActorInspectorWidgetStyle,
  stripe: boolean,
): string[] {
  const separator = "  ";
  const prefix = " ";
  const contentWidth = Math.max(8, width - prefix.length);
  const sequence = String(preview.sequence ?? 0).padStart(sequenceWidth, " ");
  const sequencePrefix = `${sequence}  `;
  const detailSequencePrefix = `${" ".repeat(sequenceWidth)}  `;
  const route = routeText(preview);
  const routePadding = " ".repeat(Math.max(0, labelWidth - route.length));
  const typePadding = " ".repeat(Math.max(0, labelWidth - preview.type.length));
  const headline = previewText(preview);
  const detail = detailText(preview);
  const headerLead = `${sequencePrefix}${route}${routePadding}${separator}`;
  const detailLead = `${detailSequencePrefix}${preview.type}${typePadding}${separator}`;
  const visibleHeadline = boundedLine(headline, Math.max(0, contentWidth - headerLead.length));
  const visibleDetail = boundedLine(detail, Math.max(0, contentWidth - detailLead.length));
  const headerPlain = `${headerLead}${visibleHeadline}`;
  const detailPlain = `${detailLead}${visibleDetail}`;
  const header = [
    style(styles.muted, sequencePrefix),
    style(styles.target, route),
    routePadding,
    separator,
    style(styles.preview, visibleHeadline),
  ].join("");
  const detailLine = [
    style(styles.muted, detailSequencePrefix),
    style(styles.type, preview.type),
    typePadding,
    separator,
    style(styles.preview, visibleDetail),
  ].join("");
  const lines = [
    `${prefix}${padLine(headerPlain, header, contentWidth, styles)}`,
    `${prefix}${padLine(detailPlain, detailLine, contentWidth, styles)}`,
  ];
  if (stripe && styles.stripe) return lines.map((line) => styles.stripe?.(line) ?? line);
  if (!stripe && styles.stripeAlt) return lines.map((line) => styles.stripeAlt?.(line) ?? line);
  return lines;
}

export function renderInspectorWidget(
  previews: ActorInspectorPreview[],
  width = 80,
  styles: ActorInspectorWidgetStyle = {},
  options: ActorInspectorRenderOptions = {},
): string[] | undefined {
  if (previews.length === 0) return undefined;
  const safeWidth = Math.max(1, width);
  const verbosity = options.verbosity ?? "verbose";
  const visibleLimit = verbosity === "compact" ? 12 : 6;
  const visible = previews
    .map((preview, index) => ({
      preview: { ...preview, sequence: preview.sequence ?? index + 1 },
      stripe: preview.stripe ?? index % 2 === 0,
    }))
    .slice(-visibleLimit);
  const sequenceWidth = Math.max(
    1,
    ...visible.map(({ preview }) => String(preview.sequence ?? 0).length),
  );
  const lines: string[] = [];
  if (verbosity === "compact") {
    const routeWidth = Math.max(...visible.map(({ preview }) => routeText(preview).length));
    const typeWidth = Math.max(...visible.map(({ preview }) => preview.type.length));
    for (const { preview, stripe } of visible) {
      lines.push(...renderCompactInspectorEntry(preview, safeWidth, sequenceWidth, routeWidth, typeWidth, styles, stripe));
    }
    return lines;
  }
  const labelWidth = Math.max(
    ...visible.flatMap(({ preview }) => [routeText(preview).length, preview.type.length]),
  );
  for (const { preview, stripe } of visible) {
    lines.push(...renderVerboseInspectorEntry(preview, safeWidth, sequenceWidth, labelWidth, styles, stripe));
  }
  return lines;
}
