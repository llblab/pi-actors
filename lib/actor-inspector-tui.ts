/**
 * Actor inspector TUI previews.
 * Zones: terminal actor inspection, room/direct message previews, no-dependency UI formatting
 */

import * as fs from "node:fs";
import * as path from "node:path";

import { visibleWidth } from "@earendil-works/pi-tui";

import type { ActorMessage } from "./actor-messages.ts";
import * as Paths from "./paths.ts";

export interface ActorInspectorPreview {
  body_preview?: string;
  channel: "broadcast" | "direct" | "room";
  from?: string;
  from_display?: string;
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

export interface ActorInspectorRenderOptions {}

export interface ActorInspectorItemViewOptions {
  sequence: number;
}

export interface ActorInspectorRosterMember {
  address: string;
  display?: string;
  role?: string;
  status?: string;
}

export interface ActorInspectorPreviewReadOptions {
  ownerId?: string;
  currentRunOnly?: boolean;
  channels?: ActorInspectorPreview["channel"][];
  mention?: string;
  roomLimitPerRun?: number;
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

function channelFor(
  message: Pick<ActorMessage, "to">,
): ActorInspectorPreview["channel"] {
  if (message.to.startsWith("room:")) return "room";
  if (message.to === "coordinator" || message.to.startsWith("session:"))
    return "broadcast";
  return "direct";
}

function previewFromMessage(
  run: string,
  message: Record<string, unknown>,
  timestamp: string,
  displayNames: Record<string, string> = {},
): ActorInspectorPreview | undefined {
  const to = typeof message.to === "string" ? message.to : undefined;
  const type = typeof message.type === "string" ? message.type : undefined;
  if (!to || !type) return undefined;
  const from = typeof message.from === "string" ? message.from : undefined;
  const summary =
    typeof message.summary === "string" ? message.summary : undefined;
  const body = asRecord(message.body);
  const display = from
    ? typeof body.display === "string" && body.display.trim()
      ? body.display.trim()
      : displayNames[from]
    : undefined;
  return {
    ...(previewValue(message.body)
      ? { body_preview: previewValue(message.body) }
      : {}),
    channel: channelFor({ to }),
    ...(from ? { from } : {}),
    ...(display ? { from_display: display } : {}),
    run,
    ...(summary ? { summary } : {}),
    timestamp,
    to,
    type,
  };
}

function readRoomRosterRecords(
  stateDir: string,
  room: string,
): Record<string, Record<string, unknown>> {
  try {
    return JSON.parse(
      fs.readFileSync(path.join(stateDir, "rooms", room, "roster.json"), "utf8"),
    ) as Record<string, Record<string, unknown>>;
  } catch {
    return {};
  }
}

function memberDisplay(_address: string, member: Record<string, unknown>): string | undefined {
  const display = typeof member.display === "string" ? member.display.trim() : "";
  return display || undefined;
}

function readRoomDisplayNames(stateDir: string, room: string): Record<string, string> {
  const roster = readRoomRosterRecords(stateDir, room);
  return Object.fromEntries(
    Object.entries(roster).flatMap(([address, member]) => {
      const display = memberDisplay(address, member);
      return display ? [[address, display]] : [];
    }),
  );
}

function readRoomPreviews(
  run: string,
  stateDir: string,
  limitPerRun?: number,
): ActorInspectorPreview[] {
  const roomsDir = path.join(stateDir, "rooms");
  try {
    const previews = fs
      .readdirSync(roomsDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .flatMap((entry) => {
        const displayNames = readRoomDisplayNames(stateDir, entry.name);
        return readJsonLines(path.join(roomsDir, entry.name, "messages.jsonl"))
          .map((message) =>
            previewFromMessage(
              run,
              message,
              String(message.received_at ?? message.timestamp ?? ""),
              displayNames,
            ),
          )
          .filter((preview): preview is ActorInspectorPreview =>
            Boolean(preview),
          );
      });
    const limit = Number.isFinite(limitPerRun) ? Math.max(0, Number(limitPerRun)) : undefined;
    return limit === undefined ? previews : previews.slice(-limit);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    return [];
  }
}

function readInboxPreviews(
  run: string,
  stateDir: string,
): ActorInspectorPreview[] {
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

function readOutboxPreviews(
  run: string,
  stateDir: string,
): ActorInspectorPreview[] {
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

function matchesPreviewFilter(
  preview: ActorInspectorPreview,
  options: ActorInspectorPreviewReadOptions,
): boolean {
  if (options.channels?.length && !options.channels.includes(preview.channel)) {
    return false;
  }
  const mention = options.mention?.trim().toLowerCase();
  if (!mention) return true;
  return [
    preview.from,
    preview.from_display,
    preview.to,
    preview.type,
    preview.summary,
    preview.body_preview,
  ].some((value) => value?.toLowerCase().includes(mention));
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
          ...readRoomPreviews(entry.name, stateDir, options.roomLimitPerRun),
          ...readInboxPreviews(entry.name, stateDir),
          ...readOutboxPreviews(entry.name, stateDir),
        ];
      })
      .filter((preview) => preview.timestamp)
      .sort((a, b) => a.timestamp.localeCompare(b.timestamp));
    const currentRun = options.currentRunOnly
      ? previews.at(-1)?.run
      : undefined;
    return previews
      .filter((preview) => !currentRun || preview.run === currentRun)
      .filter((preview) => matchesPreviewFilter(preview, options))
      .map((preview, index) => ({
        ...preview,
        sequence: index + 1,
        stripe: index % 2 === 1,
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
  const compact =
    options.preserveSpaces === false
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

function routeActorText(preview: ActorInspectorPreview): string {
  return preview.from_display || actorName(preview.from);
}

function routeText(preview: ActorInspectorPreview): string {
  const actor = routeActorText(preview);
  if (preview.channel === "room") return `${actor} # all`;
  if (preview.channel === "broadcast") return `${actor} ⇢ ${preview.to}`;
  return `${actor} → ${actorName(preview.to)}`;
}

function style(
  styleFn: ((text: string) => string) | undefined,
  text: string,
): string {
  return styleFn ? styleFn(text) : text;
}

function previewText(preview: ActorInspectorPreview): string {
  return preview.summary || preview.body_preview || "-";
}

function propertyValue(value: unknown): string {
  if (value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}

function displayWidth(value: string): number {
  return visibleWidth(value);
}

const lineSegmenter = new Intl.Segmenter();

function boundedLine(value: string, width: number): string {
  if (width <= 0) return "";
  if (visibleWidth(value) <= width) return value;
  const ellipsis = "…";
  const ellipsisWidth = visibleWidth(ellipsis);
  if (width <= ellipsisWidth) return ellipsis.slice(0, width);
  let output = "";
  let used = 0;
  const maxTextWidth = width - ellipsisWidth;
  for (const { segment } of lineSegmenter.segment(value)) {
    const segmentWidth = visibleWidth(segment);
    if (used + segmentWidth > maxTextWidth) break;
    output += segment;
    used += segmentWidth;
  }
  return `${output}${ellipsis}`;
}

function padLine(
  plain: string,
  rendered: string,
  width: number,
  styles: ActorInspectorWidgetStyle,
): string {
  const boundedPlain = boundedLine(plain, width);
  const visible =
    boundedPlain === plain ? rendered : style(styles.preview, boundedPlain);
  const padding = Math.max(0, width - visibleWidth(boundedPlain));
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
  const suffix = " ";
  const contentWidth = Math.max(8, width - prefix.length - suffix.length);
  const sequence = String(preview.sequence ?? 0).padStart(sequenceWidth, " ");
  const sequencePrefix = `${sequence}${separator}`;
  const route = routeText(preview);
  const routePadding = " ".repeat(
    Math.max(0, routeWidth - displayWidth(route)),
  );
  const typePadding = " ".repeat(
    Math.max(0, typeWidth - displayWidth(preview.type)),
  );
  const headline = previewText(preview);
  const lead = `${sequencePrefix}${route}${routePadding}${separator}${preview.type}${typePadding}${separator}`;
  const visibleHeadline = boundedLine(
    headline,
    Math.max(0, contentWidth - displayWidth(lead)),
  );
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
  const line = `${prefix}${padLine(plain, rendered, contentWidth, styles)}${suffix}`;
  if (stripe && styles.stripe) return [styles.stripe(line)];
  if (!stripe && styles.stripeAlt) return [styles.stripeAlt(line)];
  return [line];
}

function renderInspectorEntry(
  preview: ActorInspectorPreview,
  width: number,
  sequenceWidth: number,
  routeWidth: number,
  typeWidth: number,
  summaryWidth: number,
  styles: ActorInspectorWidgetStyle,
  stripe: boolean,
): string[] {
  const separator = "  ";
  const prefix = " ";
  const suffix = " ";
  const contentWidth = Math.max(8, width - prefix.length - suffix.length);
  const sequence = String(preview.sequence ?? 0).padStart(sequenceWidth, " ");
  const sequencePrefix = `${sequence}${separator}`;
  const route = routeText(preview);
  const type = preview.type;
  const summary = preview.summary?.trim() ?? "";
  const body = preview.body_preview?.trim() || (!summary ? previewText(preview) : "-");
  const visibleRoute = boundedLine(route, routeWidth);
  const visibleType = boundedLine(type, typeWidth);
  const boundedRoutePadding = " ".repeat(Math.max(0, routeWidth - displayWidth(visibleRoute)));
  const boundedTypePadding = " ".repeat(Math.max(0, typeWidth - displayWidth(visibleType)));
  const leadParts = [
    style(styles.muted, sequencePrefix),
    style(styles.target, visibleRoute),
    boundedRoutePadding,
    separator,
    style(styles.type, visibleType),
    boundedTypePadding,
    separator,
  ];
  let lead = `${sequencePrefix}${visibleRoute}${boundedRoutePadding}${separator}${visibleType}${boundedTypePadding}${separator}`;
  if (summary) {
    const visibleSummary = boundedLine(summary, summaryWidth);
    const summaryPadding = " ".repeat(Math.max(0, summaryWidth - displayWidth(visibleSummary)));
    lead += `${visibleSummary}${summaryPadding}${separator}`;
    leadParts.push(style(styles.preview, visibleSummary), summaryPadding, separator);
  }
  const visibleBody = boundedLine(body, Math.max(0, contentWidth - displayWidth(lead)));
  const plain = `${lead}${visibleBody}`;
  const rendered = `${leadParts.join("")}${style(styles.preview, visibleBody)}`;
  const line = `${prefix}${padLine(plain, rendered, contentWidth, styles)}${suffix}`;
  if (stripe && styles.stripe) return [styles.stripe(line)];
  if (!stripe && styles.stripeAlt) return [styles.stripeAlt(line)];
  return [line];
}

export function readActorInspectorRoster(
  stateRoot = Paths.getRunStateRoot(),
  run: string,
  room = "main",
): ActorInspectorRosterMember[] {
  const stateDir = path.join(stateRoot, run);
  const roster = readRoomRosterRecords(stateDir, room);
  return Object.entries(roster).map(([address, member]) => ({
    address,
    ...(memberDisplay(address, member)
      ? { display: memberDisplay(address, member) }
      : {}),
    ...(typeof member.role === "string" ? { role: member.role } : {}),
    ...(typeof member.status === "string" ? { status: member.status } : {}),
  }));
}

function rosterRoleText(role: string | undefined): string | undefined {
  const cleaned = role?.replaceAll(/\s*\([^)]*\)\s*$/g, "").trim().toLowerCase();
  if (!cleaned || cleaned === "actor") return undefined;
  return cleaned.replaceAll(/\s+/g, "-");
}

function rosterMemberText(member: ActorInspectorRosterMember): string {
  const name = member.display || actorName(member.address);
  const role = rosterRoleText(member.role);
  return role ? `${role}/${name}` : name;
}

function isRosterMemberActive(member: ActorInspectorRosterMember): boolean {
  const status = member.status?.trim().toLowerCase();
  return !status || status === "present" || status === "active" || status === "running";
}

export function renderInspectorRosterLine(
  members: ActorInspectorRosterMember[],
  width = 80,
  styles: ActorInspectorWidgetStyle = {},
): string | undefined {
  return renderInspectorRosterPanel(members, width, styles)?.[0];
}

export function renderInspectorRosterPanel(
  members: ActorInspectorRosterMember[],
  width = 80,
  styles: ActorInspectorWidgetStyle = {},
): string[] | undefined {
  if (members.length === 0) return undefined;
  const safeWidth = Math.max(1, width);
  const innerWidth = Math.max(1, safeWidth - 2);
  const prefix = `roster ${members.length}: `;
  const tokens = members.map((member) => ({
    active: isRosterMemberActive(member),
    text: rosterMemberText(member),
  }));
  const lines: string[] = [];
  let plain = prefix;
  let rendered = style(styles.muted, prefix);
  const flush = () => {
    const visible = boundedLine(plain, innerWidth);
    const line = visible === plain ? rendered : style(styles.muted, visible);
    lines.push(` ${line}${" ".repeat(Math.max(0, innerWidth - displayWidth(visible)))} `);
  };
  for (const token of tokens) {
    const separator = plain === prefix ? "" : ", ";
    const nextPlain = `${plain}${separator}${token.text}`;
    const renderedToken = style(token.active ? styles.target : styles.muted, token.text);
    if (plain !== prefix && displayWidth(nextPlain) > innerWidth) {
      flush();
      plain = `  ${token.text}`;
      rendered = `${style(styles.muted, "  ")}${renderedToken}`;
      continue;
    }
    plain = nextPlain;
    rendered = `${rendered}${style(styles.muted, separator)}${renderedToken}`;
  }
  flush();
  return lines;
}

export function renderInspectorItemView(
  previews: ActorInspectorPreview[],
  width = 80,
  styles: ActorInspectorWidgetStyle = {},
  options: ActorInspectorItemViewOptions,
): string[] | undefined {
  const preview = previews.find((item) => item.sequence === options.sequence);
  if (!preview) return undefined;
  const safeWidth = Math.max(1, width);
  const orderedKeys = [
    "channel",
    "run",
    "from",
    "from_display",
    "to",
    "type",
    "summary",
    "body_preview",
    "timestamp",
    "stripe",
  ] as const;
  const entries = orderedKeys
    .filter((key) => preview[key] !== undefined)
    .map((key) => [key, propertyValue(preview[key])] as const);
  const keyWidth = Math.max(1, ...entries.map(([key]) => displayWidth(key)));
  const sequenceText = String(preview.sequence ?? options.sequence);
  const sequencePadding = " ".repeat(Math.max(0, keyWidth - displayWidth(sequenceText)));
  const headerSeparator = "  ";
  const route = routeText(preview);
  const visibleRoute = boundedLine(
    route,
    Math.max(0, safeWidth - keyWidth - headerSeparator.length),
  );
  const headerPlain = `${sequenceText}${sequencePadding}${headerSeparator}${visibleRoute}`;
  const header = `${style(styles.muted, sequenceText)}${sequencePadding}${headerSeparator}${style(styles.target, visibleRoute)}`;
  const headerPadding = Math.max(0, safeWidth - visibleWidth(headerPlain));
  const lines = [`${header}${" ".repeat(headerPadding)}`, ""];
  for (const [key, value] of entries) {
    const keyPadding = " ".repeat(Math.max(0, keyWidth - displayWidth(key)));
    const separator = "  ";
    const valueWidth = Math.max(0, safeWidth - keyWidth - separator.length);
    const visibleValue = boundedLine(value, valueWidth);
    const plain = `${key}${keyPadding}${separator}${visibleValue}`;
    const rendered = `${style(styles.muted, key)}${keyPadding}${separator}${style(styles.preview, visibleValue)}`;
    const padding = Math.max(0, safeWidth - visibleWidth(plain));
    lines.push(`${rendered}${" ".repeat(padding)}`);
  }
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
  void options;
  const visible = previews.map((preview, index) => ({
    preview: { ...preview, sequence: preview.sequence ?? index + 1 },
    stripe: preview.stripe ?? index % 2 === 1,
  }));
  const sequenceWidth = Math.max(
    1,
    ...visible.map(({ preview }) => String(preview.sequence ?? 0).length),
  );
  const lines: string[] = [];
  const separatorWidth = 2;
  const sequencePrefixWidth = sequenceWidth + separatorWidth;
  const fixedSeparatorsWidth = separatorWidth * 3;
  const availableForColumns = Math.max(
    0,
    safeWidth - 1 - sequencePrefixWidth - fixedSeparatorsWidth,
  );
  const naturalRouteWidth = Math.max(
    ...visible.map(({ preview }) => displayWidth(routeText(preview))),
  );
  const naturalTypeWidth = Math.max(
    ...visible.map(({ preview }) => displayWidth(preview.type)),
  );
  const routeWidth = Math.min(
    naturalRouteWidth,
    Math.max(4, Math.floor(availableForColumns * 0.35)),
  );
  const typeWidth = Math.min(
    naturalTypeWidth,
    Math.max(4, Math.floor(availableForColumns * 0.25)),
  );
  const messageWidth = Math.max(0, availableForColumns - routeWidth - typeWidth);
  const summaryWidths = visible
    .map(({ preview }) => preview.summary?.trim())
    .filter((summary): summary is string => Boolean(summary))
    .map((summary) => displayWidth(summary));
  const summaryWidth = summaryWidths.length
    ? Math.min(Math.max(...summaryWidths), Math.max(1, Math.floor(messageWidth * 0.5)))
    : 0;
  for (const { preview, stripe } of visible) {
    lines.push(
      ...renderInspectorEntry(
        preview,
        safeWidth,
        sequenceWidth,
        routeWidth,
        typeWidth,
        summaryWidth,
        styles,
        stripe,
      ),
    );
  }
  return lines;
}
