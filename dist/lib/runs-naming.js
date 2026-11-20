/**
 * Session-scoped Run naming and name reservation.
 * Zones: session namespaces, recipe-derived name stems, ordinal allocation
 * Owns: session key validation, stem derivation, name reservation and its ledger.
 * Excludes: Run lifecycle, launching, directory preparation, catalog registration, retention and Control.
 */
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { withFileMutationLock, writeJsonAtomic } from "./file-state.js";
export const RUN_NAME_LEDGER_SCHEMA = "run-names-v1";
export const RUN_NAME_LEDGER_FILE = "names.json";
export const RUN_NAME_LEDGER_DIR = "names";
/** Namespace for launches without a logical session; it is a bucket, not a session identity. */
export const UNOWNED_SESSION = "_unowned";
const MAX_SESSION_KEY_LENGTH = 128;
/** One Run name bound shared by allocation, lookup and every delivery record that carries a Run name. */
export const RUN_NAME_MAX_LENGTH = 200;
const MAX_NAME_LENGTH = RUN_NAME_MAX_LENGTH;
const MAX_STEM_LENGTH = 48;
const MAX_ALLOCATION_ATTEMPTS = 1_000;
const MAX_LEDGER_ENTRIES = 50_000;
/** Retention containers inside a namespace hold already-retired evidence, never a live Run. */
export const RUN_RETENTION_CONTAINER_NAMES = Object.freeze(["archived", "preserved-artifacts"]);
/** Runtime-owned entries beside the session namespaces at the state root. */
const RUN_ROOT_RESERVED_NAMES = Object.freeze([RUN_NAME_LEDGER_DIR, "index.json", "teardown", ...RUN_RETENTION_CONTAINER_NAMES]);
/** Windows device aliases are not portable path components, with or without an extension. */
const DEVICE_ALIAS = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/iu;
const component = (value) => value.length > 0 && value.length <= MAX_NAME_LENGTH && value !== "." && value !== ".." && /^[A-Za-z0-9_.-]+$/u.test(value) &&
    !value.endsWith(".") && !DEVICE_ALIAS.test(value);
/** Case-insensitive, so a name cannot collide with a runtime entry on a case-insensitive filesystem either. */
const reservedAmong = (value, names) => names.some(name => name.toLowerCase() === value.toLowerCase());
/** A Run name may not take a runtime-owned entry of its session namespace. */
export function isUsableRunName(value) {
    return component(value) && !reservedAmong(value, RUN_RETENTION_CONTAINER_NAMES);
}
/** One directory component for a logical Pi session; unknown or unusable identities have no namespace. */
export function sessionKey(ownerId) {
    if (typeof ownerId !== "string")
        return undefined;
    const value = ownerId.trim();
    if (value.length === 0 || value.length > MAX_SESSION_KEY_LENGTH || !component(value))
        return undefined;
    if (value.startsWith(".") || reservedAmong(value, RUN_ROOT_RESERVED_NAMES))
        return undefined;
    return value;
}
/** Recipe-derived stem: the Recipe's own name, never a caller path or a generated timestamp. */ export function recipeStem(identity) {
    if (typeof identity !== "string")
        return "run";
    const tail = identity.includes("/") ? identity.slice(identity.lastIndexOf("/") + 1) : identity;
    const stripped = basename(tail.trim(), tail.trim().endsWith(".md") ? ".md" : ".json");
    const sanitized = stripped.replace(/[^A-Za-z0-9_.-]+/gu, "-").replace(/^[.-]+/u, "").replace(/[.-]+$/u, "");
    if (!sanitized)
        return "run";
    return sanitized.length > MAX_STEM_LENGTH ? sanitized.slice(0, MAX_STEM_LENGTH) : sanitized;
}
/** Session directory component, or the unowned bucket when the caller has no logical session. */
export function sessionComponent(ownerId) {
    return sessionKey(ownerId) ?? UNOWNED_SESSION;
}
/** One Run directory: the session namespace owns every name inside it. */
export function runStateDirFor(root, session, name) {
    return join(root, session, name);
}
/** Reservation state is not a Run: it lives beside the session namespaces, never inside one. */
export function runNameLedgerPath(root, session) {
    return join(root, RUN_NAME_LEDGER_DIR, `${session}.json`);
}
function readLedger(path) {
    if (!existsSync(path))
        return Object.freeze({ schema: RUN_NAME_LEDGER_SCHEMA, names: Object.freeze({}) });
    let parsed;
    try {
        parsed = JSON.parse(readFileSync(path, "utf8"));
    }
    catch {
        return undefined;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
        return undefined;
    const record = parsed;
    if (record.schema !== RUN_NAME_LEDGER_SCHEMA)
        return undefined;
    const names = record.names;
    if (!names || typeof names !== "object" || Array.isArray(names))
        return undefined;
    const entries = {};
    for (const [name, value] of Object.entries(names)) {
        if (!component(name) || !value || typeof value !== "object" || Array.isArray(value))
            return undefined;
        const item = value;
        if (Object.keys(item).some(key => !["ordinal", "recipe", "reserved_at"].includes(key)))
            return undefined;
        if (typeof item.recipe !== "string" || typeof item.reserved_at !== "string" ||
            (item.ordinal !== undefined && (!Number.isSafeInteger(item.ordinal) || item.ordinal < 0)))
            return undefined;
        entries[name] = { ...(item.ordinal === undefined ? {} : { ordinal: item.ordinal }), recipe: item.recipe, reserved_at: item.reserved_at };
    }
    return Object.freeze({ schema: RUN_NAME_LEDGER_SCHEMA, names: Object.freeze(entries) });
}
/**
 * Record an exact name that the caller already owns. Re-entering a Run keeps its name, so this is idempotent
 * instead of an allocation and a later auto allocation still skips it. The recorded Recipe is informational:
 * a singleton address can legitimately be re-entered through a different wrapper source.
 */
export function rememberRunName(root, session, recipe, name, options = {}) {
    const refused = (reason) => Object.freeze({ state: "refused", reason });
    if (!component(session) || sessionKey(session) === undefined)
        return refused("session_unavailable");
    if (typeof recipe !== "string" || recipe.length === 0 || !isUsableRunName(name))
        return refused("name_invalid");
    const path = runNameLedgerPath(root, session);
    mkdirSync(dirname(path), { recursive: true });
    return withFileMutationLock(path, () => {
        const ledger = readLedger(path);
        if (!ledger)
            return refused("ledger_invalid");
        const existing = ledger.names[name];
        if (!existing) {
            if (Object.keys(ledger.names).length >= MAX_LEDGER_ENTRIES)
                return refused("name_space_exhausted");
            const reservedAt = (options.now ?? (() => new Date()))().toISOString();
            writeJsonAtomic(path, { schema: RUN_NAME_LEDGER_SCHEMA, names: { ...ledger.names, [name]: { recipe, reserved_at: reservedAt } } });
        }
        return Object.freeze({ state: "reserved", name, recipe, session, state_dir: runStateDirFor(root, session, name) });
    });
}
/**
 * Reserve one exact name inside a session namespace. Names are never reused, so a pruned Run keeps its
 * reservation and a resumed session continues its own sequence instead of restarting it.
 */
export function reserveRunName(root, session, recipe, request, options = {}) {
    const refused = (reason) => Object.freeze({ state: "refused", reason });
    if (!component(session) || sessionKey(session) === undefined)
        return refused("session_unavailable");
    if (typeof recipe !== "string" || recipe.length === 0)
        return refused("name_invalid");
    if (request.kind === "explicit" && !isUsableRunName(request.name))
        return refused("name_invalid");
    const stem = request.kind === "auto" ? recipeStem(request.stem ?? recipe) : "";
    const requested = request.kind === "explicit" ? request.name : "";
    const path = runNameLedgerPath(root, session);
    mkdirSync(dirname(path), { recursive: true });
    return withFileMutationLock(path, () => {
        const ledger = readLedger(path);
        if (!ledger)
            return refused("ledger_invalid");
        if (Object.keys(ledger.names).length >= MAX_LEDGER_ENTRIES)
            return refused("name_space_exhausted");
        const reservedAt = (options.now ?? (() => new Date()))().toISOString();
        const commit = (name, ordinal) => {
            const names = { ...ledger.names, [name]: { ...(ordinal === undefined ? {} : { ordinal }), recipe, reserved_at: reservedAt } };
            writeJsonAtomic(path, { schema: RUN_NAME_LEDGER_SCHEMA, names });
            return Object.freeze({ state: "reserved", name, ...(ordinal === undefined ? {} : { ordinal }),
                recipe, session, state_dir: runStateDirFor(root, session, name) });
        };
        if (request.kind === "explicit") {
            return Object.hasOwn(ledger.names, requested) ? refused("run_name_taken") : commit(requested);
        }
        let ordinal = 0;
        for (let attempt = 0; attempt < MAX_ALLOCATION_ATTEMPTS; attempt += 1, ordinal += 1) {
            const name = `${stem}-${ordinal}`;
            if (!isUsableRunName(name))
                return refused("name_invalid");
            if (!Object.hasOwn(ledger.names, name))
                return commit(name, ordinal);
        }
        return refused("name_space_exhausted");
    });
}
