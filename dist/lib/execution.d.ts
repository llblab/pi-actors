/**
 * Registered tool execution runtime
 * Zones: tool execution, command templates, output formatting
 * Owns command-template invocation execution and pi tool-result payload formatting
 */
import * as CommandTemplates from "./command-templates.ts";
import type { RegisteredTool } from "./config.ts";
export interface ToolExecOptions {
    actorRecipeContext?: CommandTemplates.CommandTemplateActorRecipeContext;
    evidenceContext?: {
        acceptOutput?: "review_evidence";
        label?: string;
        repeatIndex?: string;
    };
    cwd?: string;
    signal?: AbortSignal;
    stdin?: string;
    timeout?: number;
    retry?: number;
    captureDir?: string;
    captureLimitBytes?: number;
}
export interface ToolExecResult {
    stdout: string;
    stderr: string;
    code: number;
    killed: boolean;
    stdoutBytes?: number;
    stderrBytes?: number;
    stdoutFile?: string;
    stderrFile?: string;
    evidenceRef?: string;
    stdoutTruncated?: boolean;
    stderrTruncated?: boolean;
    /** Complete internal stdout for downstream pipeline stdin; never returned to model-facing output. */
    pipelineStdout?: string;
}
export interface BranchReport {
    code: number;
    command: string;
    failureReason?: string;
    killed: boolean;
    label: string;
    status: "done" | "failed" | "timeout";
    stderr?: string;
    stderrBytes: number;
    stderrCapturedBytes: number;
    stderrFile?: string;
    stderrTruncated?: boolean;
    stdout?: string;
    stdoutBytes: number;
    stdoutCapturedBytes: number;
    stdoutFile?: string;
    stdoutTruncated?: boolean;
}
export interface SoftQuorumReport {
    coverage: number;
    degraded: boolean;
    done: number;
    expected: number;
    failed: number;
    usable: boolean;
}
export interface RegisteredToolExecutionResult {
    content: Array<{
        type: "text";
        text: string;
    }>;
    details: {
        branches?: BranchReport[];
        code: number;
        command: string;
        fullOutputPath?: string;
        killed: boolean;
        launch_kind: "tool";
        stderrBytes?: number;
        stderrCapturedBytes?: number;
        stderrFile?: string;
        stderrTruncated?: boolean;
        stdoutBytes?: number;
        stdoutCapturedBytes?: number;
        stdoutFile?: string;
        stdoutTruncated?: boolean;
        nonCriticalFailures?: Array<{
            code: number;
            command: string;
            killed: boolean;
        }>;
        softQuorum?: SoftQuorumReport;
        failureReason?: string;
        template: CommandTemplates.CommandTemplateValue;
        templateWarnings?: string[];
        tool: string;
        truncated: boolean;
    };
}
export type RegisteredToolExec = (command: string, args: string[], options?: ToolExecOptions) => Promise<ToolExecResult>;
export declare function applyOutputAcceptancePolicy(result: ToolExecResult, output: string | undefined): Promise<ToolExecResult>;
export declare function executeRegisteredTool(cfg: RegisteredTool, params: Record<string, unknown>, exec: RegisteredToolExec, cwd: string, signal?: AbortSignal): Promise<RegisteredToolExecutionResult>;
