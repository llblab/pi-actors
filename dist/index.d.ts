/**
 * pi-actors — actor runtime and persistent local tool registry for pi.
 * Zones: composition root, pi agent, actor runtime
 * Owns extension composition and Pi event registration, not domain behavior.
 */
import * as Pi from "./lib/pi.ts";
export default function toolRegistryExtension(pi: Pi.ExtensionAPI): void;
