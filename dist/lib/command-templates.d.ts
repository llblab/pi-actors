/**
 * Command-template execution standard.
 * Zones: shell-free command parsing, placeholder expansion, local process execution, composition semantics
 * Owns portable command-template parsing, expansion, risk checks, retries, timeouts, and direct execution.
 */
import { type ChildProcess } from "node:child_process";
export type CommandTemplateFailureScope = "continue" | "branch" | "root";
export interface CommandTemplateActorRecipeContext {
    alias?: string;
    file?: string;
    name?: string;
    path?: string;
    role?: string;
}
export interface CommandTemplateObjectConfig {
    actorRecipeContext?: CommandTemplateActorRecipeContext;
    label?: string;
    parallel?: boolean;
    concurrency?: number | string;
    min_successful?: number | string;
    when?: boolean | string;
    template?: CommandTemplateValue;
    args?: string[];
    defaults?: Record<string, unknown>;
    timeout?: number | string;
    delay?: number | string;
    accept_output?: "review_evidence";
    output?: string;
    retry?: number | string;
    failure?: CommandTemplateFailureScope;
    recover?: CommandTemplateValue;
    repeat?: number | string;
}
export type CommandTemplateValue = string | CommandTemplateConfig[] | CommandTemplateObjectConfig;
export type CommandTemplateConfig = string | CommandTemplateObjectConfig;
export interface CommandTemplateLeafConfig extends CommandTemplateObjectConfig {
    template: string;
}
export interface CommandTemplateInvocation {
    command: string;
    args: string[];
}
export interface CommandTemplateExecOptions {
    /** Kernel-only synchronous admission around each native spawn, including retries. */
    admitSpawn?: (start: () => ChildProcess) => ChildProcess;
    /** Kernel-only fresh handle after capture/exit management, inside synchronous spawn admission. Not birth proof. */
    onAttemptManaged?: (context: CommandTemplateManagedAttempt) => void;
    /** Kernel observation of settled attempts only; no receipt exists for a denied spawn. */
    onAttemptComplete?: (receipt: CommandTemplateAttemptReceipt) => void;
    cwd?: string;
    timeout?: number;
    signal?: AbortSignal;
    stdin?: string;
    killGrace?: number;
    retry?: number;
    captureDir?: string;
    captureLimitBytes?: number;
}
export interface CommandTemplateExecResult {
    stdout: string;
    stderr: string;
    code: number;
    killed: boolean;
    stdoutBytes?: number;
    stderrBytes?: number;
    stdoutFile?: string;
    stderrFile?: string;
    stdoutTruncated?: boolean;
    stderrTruncated?: boolean;
    stdoutCaptureIncomplete?: true;
    stderrCaptureIncomplete?: true;
    stdoutFileBytes?: number;
    stderrFileBytes?: number;
}
export interface CommandTemplateManagedAttempt {
    readonly attempt: number;
    readonly process: ChildProcess;
}
export interface CommandTemplateSpawnAdmission {
    readonly attempt: number;
}
/** Available only before this synchronous admission invokes its factory; never retroactively adopt a born process. */
export declare function readPendingCommandSpawnAdmission(): CommandTemplateSpawnAdmission | undefined;
/** Kernel-only launch observation capability; copies and references retained past the callback are not authority. */
export declare function requireFreshManagedCommandAttempt(context: CommandTemplateManagedAttempt, admission?: CommandTemplateSpawnAdmission): CommandTemplateManagedAttempt;
export interface CommandTemplateAttemptReceipt {
    readonly attempt: number;
    /** Kernel-only digest of observed stdout bytes after complete capture persistence; not exposure/native authority. */
    readonly stdoutSha256?: string;
    readonly result: Readonly<CommandTemplateExecResult>;
    readonly nativeExitCode?: number | null;
    readonly nativeSignal?: NodeJS.Signals | null;
}
export interface CommandTemplateNativeClose {
    readonly pid: number;
    readonly nativeExitCode: number | null;
    readonly nativeSignal: NodeJS.Signals | null;
}
/** Exact retained process close during its synchronous receipt callback, never a serialized terminal claim. */
export declare function requireNativeCommandAttemptClose(receipt: CommandTemplateAttemptReceipt, admission: CommandTemplateSpawnAdmission, child: ChildProcess): CommandTemplateNativeClose;
export type CommandTemplateRiskLabel = "risk.shell" | "risk.eval" | "risk.broad_fs_write" | "risk.destructive_fs" | "risk.network" | "risk.external_side_effect" | "risk.long_running" | "risk.platform_specific" | "risk.secret_touching";
export type CommandTemplateExecCommand = (command: string, args: string[], options?: CommandTemplateExecOptions) => Promise<CommandTemplateExecResult>;
export declare function normalizeCommandTemplateConfig(config: CommandTemplateConfig): CommandTemplateObjectConfig;
export declare function resolveInheritedDefaultReferences(ownDefaults: Record<string, unknown> | undefined, inheritedDefaults: Record<string, unknown> | undefined, runtimeValues?: Record<string, unknown>): Record<string, unknown> | undefined;
export declare function resolveCommandTemplateRepeat(value: number | string | undefined, values?: Record<string, unknown>): number | undefined;
export declare function isCommandTemplateRepeatPlaceholder(name: string): boolean;
export declare function getCommandTemplateRepeatDefaults(index: number, repeat: number): Record<string, string>;
export declare function expandCommandTemplateConfigs(config: CommandTemplateConfig, inherited?: Pick<CommandTemplateObjectConfig, "args" | "defaults">): CommandTemplateLeafConfig[];
export declare function getCommandTemplateWarnings(config: CommandTemplateConfig): string[];
export declare function getCommandTemplateRiskLabels(config: CommandTemplateConfig): CommandTemplateRiskLabel[];
export declare function getCommandTemplateDefaults(config: CommandTemplateConfig | undefined): Record<string, string>;
export declare function splitCommandTemplate(input: string): string[];
export declare function expandCommandTemplateExecutable(command: string, cwd: string): string;
export type CommandTemplateExecutableResolver = (name: string) => string | undefined;
export declare function resolveCommandTemplateScriptInvocation(invocation: CommandTemplateInvocation, resolveExecutable?: CommandTemplateExecutableResolver): CommandTemplateInvocation;
export declare function shouldRunCommandTemplateNode(value: boolean | string | undefined, values: Record<string, unknown>): boolean;
export declare function substituteCommandTemplateToken(token: string, values: Record<string, unknown>, missingLabel?: string, depth?: number): string;
export declare function execCommandTemplate(command: string, args: string[], options?: CommandTemplateExecOptions): Promise<CommandTemplateExecResult>;
export declare function buildCommandTemplateInvocation(config: CommandTemplateConfig, values: Record<string, unknown>, cwd: string, options?: {
    emptyMessage?: string;
    missingLabel?: string;
}): CommandTemplateInvocation;
