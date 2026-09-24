/**
 * Actor Inspector command adapter.
 * Zones: Pi command registration, overlay construction, owned-run control ports
 * Owns host-facing Inspector launch wiring without owning Inspector state or actions.
 */
import type * as Pi from "./pi.ts";
export declare function registerActorInspectorCommand(pi: Pi.ExtensionAPI, getRunOwnerId: (ctx: Pi.ExtensionContext) => string): void;
