/**
 * Session-scoped Run naming and name reservation.
 * Zones: session namespaces, recipe-derived name stems, ordinal allocation
 * Owns: session key validation, stem derivation, name reservation and its ledger.
 * Excludes: Run lifecycle, launching, directory preparation, catalog registration, retention and Control.
 */
export declare const RUN_NAME_LEDGER_SCHEMA = "run-names-v1";
export declare const RUN_NAME_LEDGER_FILE = "names.json";
export declare const RUN_NAME_LEDGER_DIR = "names";
/** Namespace for launches without a logical session; it is a bucket, not a session identity. */
export declare const UNOWNED_SESSION = "_unowned";
/** One Run name bound shared by allocation, lookup and every delivery record that carries a Run name. */
export declare const RUN_NAME_MAX_LENGTH = 200;
export type RunNameRequest = {
    readonly kind: "auto";
    readonly stem?: string;
} | {
    readonly kind: "explicit";
    readonly name: string;
};
export type RunNameRefusalReason = "ledger_invalid" | "name_invalid" | "name_space_exhausted" | "run_name_taken" | "session_unavailable";
export type RunNameReservation = {
    readonly state: "reserved";
    readonly name: string;
    readonly ordinal?: number;
    readonly recipe: string;
    readonly session: string;
    readonly state_dir: string;
} | {
    readonly state: "refused";
    readonly reason: RunNameRefusalReason;
};
/** Retention containers inside a namespace hold already-retired evidence, never a live Run. */
export declare const RUN_RETENTION_CONTAINER_NAMES: readonly string[];
/** A Run name may not take a runtime-owned entry of its session namespace. */
export declare function isUsableRunName(value: string): boolean;
/** One directory component for a logical Pi session; unknown or unusable identities have no namespace. */
export declare function sessionKey(ownerId: string | undefined): string | undefined;
/** Recipe-derived stem: the Recipe's own name, never a caller path or a generated timestamp. */ export declare function recipeStem(identity: string | undefined): string;
/** Session directory component, or the unowned bucket when the caller has no logical session. */
export declare function sessionComponent(ownerId: string | undefined): string;
/** One Run directory: the session namespace owns every name inside it. */
export declare function runStateDirFor(root: string, session: string, name: string): string;
/** Reservation state is not a Run: it lives beside the session namespaces, never inside one. */
export declare function runNameLedgerPath(root: string, session: string): string;
/**
 * Record an exact name that the caller already owns. Re-entering a Run keeps its name, so this is idempotent
 * instead of an allocation and a later auto allocation still skips it. The recorded Recipe is informational:
 * a singleton address can legitimately be re-entered through a different wrapper source.
 */
export declare function rememberRunName(root: string, session: string, recipe: string, name: string, options?: {
    readonly now?: () => Date;
}): RunNameReservation;
/**
 * Reserve one exact name inside a session namespace. Names are never reused, so a pruned Run keeps its
 * reservation and a resumed session continues its own sequence instead of restarting it.
 */
export declare function reserveRunName(root: string, session: string, recipe: string, request: RunNameRequest, options?: {
    readonly now?: () => Date;
}): RunNameReservation;
