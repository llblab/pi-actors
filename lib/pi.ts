/**
 * Pi SDK adapter boundary.
 * Zones: pi agent sdk boundary, extension host adapters
 * Owns direct pi SDK imports and exposes narrow pi-actors-facing helpers/types for the composition root.
 */

import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";

export type { ExtensionAPI, ExtensionContext };

export interface PiNotificationSink {
  notify(message: string, level: "info" | "warning" | "error"): void;
  sendFollowUp(message: {
    customType: string;
    content: string;
    display: true;
    details: unknown;
  }): void;
}

export function getSessionId(ctx: ExtensionContext): string {
  return ctx.sessionManager.getSessionId();
}

export function createNotificationSink(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
): PiNotificationSink {
  return {
    notify: (message, level) => ctx.ui.notify(message, level),
    sendFollowUp: (message) =>
      pi.sendMessage(message, {
        deliverAs: "followUp",
        triggerTurn: true,
      }),
  };
}

export function registerToolDefinitions(
  pi: ExtensionAPI,
  definitions: Iterable<unknown>,
): void {
  for (const definition of definitions) pi.registerTool(definition as never);
}
