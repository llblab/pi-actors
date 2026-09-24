/**
 * Registered tool execution output.
 * Zones: command execution results, bounded output formatting, temp artifacts
 * Owns stdout/stderr failure formatting, tail truncation, and full-output temp-file persistence.
 */
export interface FormattedOutput {
    text: string;
    truncated: boolean;
    fullOutputPath?: string;
}
export declare function writeFullOutput(toolName: string, stream: string, content: string): string | undefined;
export declare function formatSize(bytes: number): string;
export declare function byteLength(value: string): number;
export declare function trimToTailBytes(value: string, maxBytes: number): string;
export declare function truncateTailContent(content: string): {
    content: string;
    outputBytes: number;
    outputLines: number;
    totalBytes: number;
    totalLines: number;
    truncated: boolean;
};
export declare function formatToolText(text: string): string;
export declare function formatOutput(toolName: string, stream: string, content: string): FormattedOutput;
export declare function formatFailureOutput(toolName: string, code: number, killed: boolean, stdout: string, stderr: string): FormattedOutput;
