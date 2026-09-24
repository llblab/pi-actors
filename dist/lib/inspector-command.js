/**
 * Actor Inspector command adapter.
 * Zones: Pi command registration, overlay construction, owned-run control ports
 * Owns host-facing Inspector launch wiring without owning Inspector state or actions.
 */
import * as AsyncRuns from "./async-runs.js";
import * as InspectorActions from "./inspector-actions.js";
import * as InspectorOverlay from "./inspector-overlay.js";
import * as Paths from "./paths.js";
export function registerActorInspectorCommand(pi, getRunOwnerId) {
    pi.registerCommand("actor-inspector", {
        description: "Open the keyboard-driven Actor Inspector",
        handler: async (_args, ctx) => {
            ctx.ui.setWidget("zz-pi-actors-comms", undefined);
            await ctx.ui.custom((tui, theme, _keybindings, done) => new InspectorOverlay.ActorInspectorOverlay({
                done,
                killRun: (run, runInstanceId) => InspectorActions.killOwnedRunFromInspector(getRunOwnerId(ctx), run, Paths.EXTENSION_RUNTIME_PATHS.runStateRoot, runInstanceId, {
                    getRunStatus: AsyncRuns.getRunStatus,
                    killRun: AsyncRuns.killRun,
                }),
                ownerId: getRunOwnerId(ctx),
                stateRoot: Paths.EXTENSION_RUNTIME_PATHS.runStateRoot,
                theme,
                tui,
            }), {
                overlay: true,
                overlayOptions: {
                    anchor: "center",
                    width: "94%",
                    minWidth: 72,
                    maxHeight: "94%",
                    margin: 1,
                },
            });
        },
    });
}
