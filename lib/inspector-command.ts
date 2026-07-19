/**
 * Actor Inspector command adapter.
 * Zones: Pi command registration, overlay construction, owned-run control ports
 * Owns host-facing Inspector launch wiring without owning Inspector state or actions.
 */

import * as AsyncRuns from "./async-runs.ts";
import * as InspectorActions from "./inspector-actions.ts";
import * as InspectorOverlay from "./inspector-overlay.ts";
import * as Paths from "./paths.ts";
import type * as Pi from "./pi.ts";

export function registerActorInspectorCommand(
  pi: Pi.ExtensionAPI,
  getRunOwnerId: (ctx: Pi.ExtensionContext) => string,
): void {
  pi.registerCommand("actors-inspector", {
    description: "Open the keyboard-driven actor inspector overlay",
    handler: async (_args, ctx) => {
      ctx.ui.setWidget("zz-pi-actors-comms", undefined);
      await ctx.ui.custom<void>(
        (tui, theme, _keybindings, done) =>
          new InspectorOverlay.ActorInspectorOverlay({
            done,
            killRun: (run, runInstanceId) =>
              InspectorActions.killOwnedInspectorRun(
                getRunOwnerId(ctx),
                run,
                Paths.EXTENSION_RUNTIME_PATHS.runStateRoot,
                runInstanceId,
                {
                  getRunStatus: AsyncRuns.getRunStatus,
                  killRun: AsyncRuns.killRun,
                },
              ),
            ownerId: getRunOwnerId(ctx),
            stateRoot: Paths.EXTENSION_RUNTIME_PATHS.runStateRoot,
            theme,
            tui,
          }),
        {
          overlay: true,
          overlayOptions: {
            anchor: "center",
            width: "94%",
            minWidth: 72,
            maxHeight: "94%",
            margin: 1,
          },
        },
      );
    },
  });
}
