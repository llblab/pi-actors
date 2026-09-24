/**
 * Immutable runtime package identity.
 * Zones: source/installed package version resolution and Run-state schema marker
 * Owns package-local identity reads; runtime status and Run persistence remain in their domains.
 */
export declare const RUN_STATE_SCHEMA: "run-kernel-v1";
export declare function getPackageVersion(): string;
