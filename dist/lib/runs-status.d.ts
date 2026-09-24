/**
 * Async run status and log readers.
 * Owns: status derivation from run state files plus bounded log/event tails.
 */
export type AsyncRunStatus = "running" | "done" | "failed" | "exited" | "cancelled" | "killed";
type RunJsonReader = (path: string) => Record<string, unknown> | undefined;
export declare function buildRunStatus(stateDir: string, runOrDir: string, meta: Record<string, unknown>, readJson: RunJsonReader, _runnerPath: string, _runnerIdentityGraceMs: number): Record<string, unknown>;
export declare function tailFile(path: string, lines: number): string;
export declare function tailLines(path: string, lines: number): string[];
export {};
