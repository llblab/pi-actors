/**
 * Async run start guards.
 * Owns: active-run reuse checks, start lock acquisition, and safe state-dir
 * preparation before a new runner process is spawned.
 */
import { type FileMutationLockOptions } from "./file-state.ts";
type RunJsonReader = (path: string) => Record<string, unknown> | undefined;
export declare function readActiveOwnedRunState(stateDir: string, readJson: RunJsonReader, _runnerPath: string): Record<string, unknown> | undefined;
export declare function assertNoActiveRunState(stateDir: string, readJson: RunJsonReader, runnerPath: string): void;
export declare function acquireStateStartLock(stateDir: string, options?: FileMutationLockOptions): () => void;
export declare function prepareStateDirForStart(stateDir: string, readJson: RunJsonReader, _runnerPath: string): void;
export {};
