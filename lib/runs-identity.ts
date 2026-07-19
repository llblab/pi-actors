/**
 * Async run identity helpers.
 * Owns: run id normalization shared by run lifecycle and retention paths.
 */

export function safeRunId(value: string | undefined): string {
  const run = (value || `run-${Date.now()}`).trim();
  if (!/^[A-Za-z0-9_.-]+$/.test(run)) {
    throw new Error(
      "Run id may contain only letters, numbers, dot, underscore, and dash.",
    );
  }
  return run;
}
