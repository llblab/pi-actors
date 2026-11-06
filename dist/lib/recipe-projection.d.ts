/** Pure Recipe-provenance privacy for captured evidence; this callback grants no runtime authority. */
export declare function createRunRecipeEvidenceRedactor(meta: Record<string, unknown>, maxTextChars?: number): (value: unknown) => unknown;
/** Literal sensitive-key privacy from captured data; does not admit metadata, references or producers. */
export declare function capturedSecretMask(meta: Record<string, unknown>, replacement?: string): (text: string) => string;
/** Original-publication body policy for already-admitted data; defaults elsewhere remain per-call origin/generic privacy. */
export declare function createRunRecipeBodyRedactor(meta: Record<string, unknown>, maxTextChars?: number): (value: unknown) => unknown;
/** Complete source text keeps public JSON spelling/BOM; never project its serialized protected JSON a second time. */
export declare function createRunRecipeTextRedactor(meta: Record<string, unknown>): (text: string) => string;
/** Pure comparison for already-admitted closed reference data, never identity/source/body authority. */
export declare function createContextIdentityPrivacyCheck(original: Record<string, unknown>): (identity: object) => boolean;
export interface RunRecipeView {
    composition: Array<Record<string, unknown>>;
    definition?: Record<string, unknown>;
    diagnostics: string[];
    identity: Record<string, unknown>;
    launch: Record<string, unknown>;
}
export declare function projectRunRecipe(meta: Record<string, unknown>, diagnostics?: readonly string[], redactEvidence?: (value: unknown) => unknown): RunRecipeView;
