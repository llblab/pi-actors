/**
 * Automatic draft-review contract.
 * Zones: read-only reviewer input, decision schema, mechanical promotion gates
 * Owns strict batch review validation without mutating recipes or registry state.
 */

export interface DraftReviewAssessment {
  flexibility: number;
  futureUsefulness: number;
  launches: number;
  safety: string;
  universality: number;
}

export interface DraftReviewDraft {
  diagnostics?: unknown;
  path: string;
  recipe?: Record<string, unknown>;
  riskLabels: string[];
  sha256: string;
  usage?: Record<string, unknown>;
  valid: boolean;
}

export interface DraftReviewActiveTool {
  name: string;
  path: string;
  sha256: string;
}

export interface DraftReviewInput {
  activeTools: DraftReviewActiveTool[];
  batchId: string;
  createdAt: string;
  drafts: DraftReviewDraft[];
}

export interface DraftReviewDecision {
  action: "discard" | "promote";
  assessment: DraftReviewAssessment;
  draft: string;
  rationale: string;
  recipe?: Record<string, unknown>;
  sha256: string;
  target?: string;
  targetSha256?: null;
}

export interface DraftReviewResult {
  batchId: string;
  createdAt: string;
  decisions: DraftReviewDecision[];
}

export interface DraftReviewValidation {
  errors: string[];
  ok: boolean;
}

const UUID_PATTERN = /^[a-f0-9-]{36}$/u;
const TOOL_NAME_PATTERN = /^[a-z][a-z0-9_]*$/u;
const SECRET_KEY = /^(?:api(?:key|token)|access(?:key|token)|authorization|auth(?:key|token)|clientsecret|cookie|credential|credentials|password|passphrase|privatekey|refreshtoken|secret|secretaccesskey|sessiontoken|token|vaulttoken)$/u;
const SECRET_TEXT = /(?:bearer\s+[a-z0-9._~+/=-]+|(?:api[-_]?key|access[-_]?token|authorization|auth[-_]?token|client[-_]?secret|cookie|credential|password|passphrase|private[-_]?key|refresh[-_]?token|secret(?:[-_]?access[-_]?key)?|token)\s*[:=]\s*[^\s,;}]+)/iu;
const PRIVATE_KEY_TEXT = /-----BEGIN(?: [A-Z0-9]+)? PRIVATE KEY-----/u;
const CREDENTIAL_TOKEN = /(?:\b(?:AKIA|ASIA)[A-Z0-9]{16}\b|\bgithub_pat_[A-Za-z0-9_]{20,}\b|\bgh[pousr]_[A-Za-z0-9]{20,}\b|\bglpat-[A-Za-z0-9_-]{20,}\b|\bnpm_[A-Za-z0-9]{20,}\b|\bxox[baprs]-[A-Za-z0-9-]{10,}\b)/u;
const AWS_SECRET_REFERENCE = /(?:^|[\s"'])(?:~[\\/]\.aws[\\/](?:credentials|config)|[^\s"']*[\\/]\.aws[\\/](?:credentials|config)|AWS_(?:ACCESS_KEY_ID|SECRET_ACCESS_KEY|SESSION_TOKEN)\b|aws\s+secretsmanager\b)/iu;
const SECRET_MANAGER_REFERENCE = /(?:\bvault\s+(?:kv\s+)?(?:get|read|write|put|list)\b|\bVAULT_TOKEN\b|\b(?:az\s+keyvault|gcloud\s+secrets\s+versions\s+access)\b)/iu;
const TEMPORARY_PATH = /(?:^|[\s"'])(?:\/tmp\/|\/var\/tmp\/|[a-z]:\\(?:temp|tmp)\\|[^\s"']*\.pi[\\/]agent[\\/]tmp[\\/])/iu;

function normalizedKey(key: string): string {
  return key.replace(/[^a-z0-9]/giu, "").toLowerCase();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function hasOnlyKeys(record: Record<string, unknown>, allowed: string[]): boolean {
  const keys = new Set(allowed);
  return Object.keys(record).every((key) => keys.has(key));
}

function finiteScore(value: unknown): boolean {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

export function findUnsafeRecipeReason(value: unknown, key = ""): string | undefined {
  if (key && SECRET_KEY.test(normalizedKey(key))) return `secret-bearing key: ${key}`;
  if (typeof value === "string") {
    if (PRIVATE_KEY_TEXT.test(value)) return "private-key material";
    if (CREDENTIAL_TOKEN.test(value)) return "credential-shaped value";
    if (AWS_SECRET_REFERENCE.test(value)) return "AWS credential reference";
    if (SECRET_MANAGER_REFERENCE.test(value)) return "secret-manager reference";
    if (SECRET_TEXT.test(value)) return "secret-bearing value";
    if (TEMPORARY_PATH.test(value)) return "temporary path";
    return undefined;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const reason = findUnsafeRecipeReason(item);
      if (reason) return reason;
    }
    return undefined;
  }
  if (isRecord(value)) {
    for (const [childKey, child] of Object.entries(value)) {
      const reason = findUnsafeRecipeReason(child, childKey);
      if (reason) return reason;
    }
  }
  return undefined;
}

function validateAssessment(
  value: unknown,
  draft: string,
  errors: string[],
): value is DraftReviewAssessment {
  if (!isRecord(value) || !hasOnlyKeys(value, [
    "flexibility",
    "futureUsefulness",
    "launches",
    "safety",
    "universality",
  ])) {
    errors.push(`invalid assessment shape: ${draft}`);
    return false;
  }
  if (
    !finiteScore(value.flexibility) ||
    !finiteScore(value.futureUsefulness) ||
    !finiteScore(value.universality) ||
    typeof value.launches !== "number" ||
    !Number.isInteger(value.launches) ||
    value.launches < 0 ||
    typeof value.safety !== "string" ||
    !value.safety.trim()
  ) {
    errors.push(`invalid assessment values: ${draft}`);
    return false;
  }
  return true;
}

export function validateDraftReviewInput(
  input: DraftReviewInput,
): DraftReviewValidation {
  const errors: string[] = [];
  if (!UUID_PATTERN.test(input.batchId)) errors.push("review input batchId must be a UUID");
  if (!input.createdAt || Number.isNaN(Date.parse(input.createdAt))) {
    errors.push("review input createdAt must be an ISO timestamp");
  }
  if (!Array.isArray(input.drafts) || input.drafts.length === 0) {
    errors.push("review input drafts must be a non-empty array");
  }
  const paths = new Set<string>();
  for (const draft of input.drafts ?? []) {
    if (
      !draft ||
      typeof draft.path !== "string" ||
      typeof draft.sha256 !== "string" ||
      typeof draft.valid !== "boolean" ||
      !Array.isArray(draft.riskLabels) ||
      draft.riskLabels.some((label) => typeof label !== "string") ||
      paths.has(draft.path)
    ) {
      errors.push(`invalid or duplicate review draft: ${String(draft?.path)}`);
      continue;
    }
    paths.add(draft.path);
  }
  const names = new Set<string>();
  for (const tool of input.activeTools ?? []) {
    if (
      !tool ||
      !TOOL_NAME_PATTERN.test(tool.name) ||
      typeof tool.path !== "string" ||
      typeof tool.sha256 !== "string" ||
      names.has(tool.name)
    ) {
      errors.push(`invalid or duplicate active tool: ${String(tool?.name)}`);
      continue;
    }
    names.add(tool.name);
  }
  return { errors, ok: errors.length === 0 };
}

export function validateDraftReviewResult(
  input: DraftReviewInput,
  result: DraftReviewResult,
): DraftReviewValidation {
  const errors = [...validateDraftReviewInput(input).errors];
  if (result.batchId !== input.batchId) errors.push("review result batch identity mismatch");
  if (!result.createdAt || Number.isNaN(Date.parse(result.createdAt))) {
    errors.push("review result createdAt must be an ISO timestamp");
  }
  if (!Array.isArray(result.decisions)) {
    errors.push("review decisions must be an array");
    return { errors, ok: false };
  }
  const inventory = new Map(input.drafts.map((draft) => [draft.path, draft]));
  const activeNames = new Set(input.activeTools.map((tool) => tool.name));
  const selectedNames = new Set<string>();
  const seen = new Set<string>();
  for (const decision of result.decisions) {
    if (!isRecord(decision) || !hasOnlyKeys(decision, [
      "action",
      "assessment",
      "draft",
      "rationale",
      "recipe",
      "sha256",
      "target",
      "targetSha256",
    ])) {
      errors.push("invalid review decision shape");
      continue;
    }
    const draftPath = String(decision.draft ?? "");
    const source = inventory.get(draftPath);
    if (!source) {
      errors.push(`unknown review draft: ${draftPath}`);
      continue;
    }
    if (seen.has(draftPath)) {
      errors.push(`duplicate review decision: ${draftPath}`);
      continue;
    }
    seen.add(draftPath);
    if (decision.sha256 !== source.sha256) {
      errors.push(`review draft changed: ${draftPath}`);
    }
    if (typeof decision.rationale !== "string" || !decision.rationale.trim()) {
      errors.push(`missing review rationale: ${draftPath}`);
    }
    if (validateAssessment(decision.assessment, draftPath, errors)) {
      const recordedLaunches = Number(
        source.usage?.lifetime_calls ?? source.usage?.calls ?? 0,
      );
      if (decision.assessment.launches !== recordedLaunches) {
        errors.push(`assessment launch count differs from lineage: ${draftPath}`);
      }
    }
    if (decision.action === "discard") {
      if (
        decision.target !== undefined ||
        decision.targetSha256 !== undefined ||
        decision.recipe !== undefined
      ) {
        errors.push(`discard decision declares promotion fields: ${draftPath}`);
      }
      continue;
    }
    if (decision.action !== "promote") {
      errors.push(`invalid review action: ${draftPath}`);
      continue;
    }
    if (!source.valid) {
      errors.push(`invalid draft may only be discarded: ${draftPath}`);
    }
    if (source.riskLabels.includes("risk.secret_touching")) {
      errors.push(`secret-touching draft may only be discarded: ${draftPath}`);
    }
    if (
      typeof source.usage?.demoted_fingerprint === "string" &&
      source.usage.demoted_fingerprint === source.usage.fingerprint
    ) {
      errors.push(
        `demoted draft requires a revision before automatic promotion: ${draftPath}`,
      );
    }
    if (
      typeof decision.target !== "string" ||
      !TOOL_NAME_PATTERN.test(decision.target)
    ) {
      errors.push(`promotion requires snake_case target: ${draftPath}`);
    } else if (activeNames.has(decision.target) || selectedNames.has(decision.target)) {
      errors.push(`promotion target is not uniquely absent: ${decision.target}`);
    } else {
      selectedNames.add(decision.target);
    }
    if (decision.targetSha256 !== null) {
      errors.push(`promotion must bind an absent target: ${draftPath}`);
    }
    if (decision.recipe !== undefined) {
      errors.push(`promotion must not supply executable recipe content: ${draftPath}`);
    }
    if (!isRecord(source.recipe) || !Object.hasOwn(source.recipe, "template")) {
      errors.push(`promotion source requires complete recipe: ${draftPath}`);
    } else {
      const unsafe = findUnsafeRecipeReason(source.recipe);
      if (unsafe) errors.push(`unsafe promotion source (${unsafe}): ${draftPath}`);
    }
  }
  for (const draft of input.drafts) {
    if (!seen.has(draft.path)) errors.push(`missing review decision: ${draft.path}`);
  }
  return { errors, ok: errors.length === 0 };
}

export function parseDraftReviewResult(stdout: string): DraftReviewResult {
  const marker = "DRAFT_REVIEW_RESULT";
  const markerIndex = stdout.lastIndexOf(marker);
  if (markerIndex < 0) throw new Error("Draft reviewer output marker is missing.");
  const payload = stdout.slice(markerIndex + marker.length).trim();
  if (!payload.startsWith("{") || !payload.endsWith("}")) {
    throw new Error("Draft reviewer output must end with one JSON object.");
  }
  const value = JSON.parse(payload) as unknown;
  if (!isRecord(value)) throw new Error("Draft reviewer result must be an object.");
  return value as unknown as DraftReviewResult;
}

export function createDraftReviewPrompt(inputPath: string): string {
  return [
    `Read the immutable draft-review batch at ${inputPath}.`,
    "Evaluate every draft independently from launch history, universality, flexibility, parameterization, duplication, safety, and likely future usefulness.",
    "Choose exactly one action per draft: promote or discard. There is no selection quota: zero, one, some, or all drafts may be promoted.",
    "Promotion requires a unique absent snake_case target and targetSha256: null. Never return recipe content: the deterministic executor promotes the exact immutable captured source without granting the reviewer executable-authoring authority. Invalid, secret-touching, or unchanged automatically demoted drafts must be discarded; a demoted draft becomes automatically eligible only after its executable fingerprint changes.",
    "Provide assessment { launches, universality, flexibility, futureUsefulness, safety }; scores are evidence, not hard thresholds.",
    "Do not create, update, move, register, or delete recipes. You are a read-only reviewer; the extension executor owns all mutation.",
    "End stdout with DRAFT_REVIEW_RESULT on its own line followed by exactly one JSON result object: { batchId, createdAt, decisions }.",
  ].join("\n");
}
