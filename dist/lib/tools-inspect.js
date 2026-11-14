/**
 * Public inspect tool behavior.
 * Zones: Run Recipe/Trace/Control views and runtime/recipe/tool diagnostics
 * Owns exact inspect target/view dispatch; source projection stays in domain modules.
 */
import { existsSync, statSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import * as AsyncRuns from "./async-runs.js";
import * as ControlProjection from "./control-projection.js";
import * as Inspector from "./inspector.js";
import * as Limits from "./limits.js";
import { computeRunControlCapacity } from "./run-evidence-policy.js";
import * as Paths from "./paths.js";
import * as RecipesDiscovery from "./recipes-discovery.js";
import * as RecipesReferences from "./recipes-references.js";
import * as ReviewDiagnostics from "./review-diagnostics.js";
import * as RunsControls from "./runs-controls.js";
import { readRunSessionNavigation } from "./runs-index.js";
import * as RunControlDelivery from "./runs-control-delivery.js";
import * as RunsTrace from "./runs-trace.js";
import * as RuntimeIdentity from "./runtime-identity.js";
import * as RuntimeTriage from "./runtime-triage.js";
import * as Schema from "./schema.js";
import * as ToolsAccess from "./tools-access.js";
import * as ToolsResponse from "./tools-response.js";
import * as TraceProjection from "./trace-projection.js";
const asRecord = ToolsResponse.asRecord;
function runtimeStatus() {
    return {
        automatic_review: Paths.isAutomaticRecipeReviewEnabled(),
        run_root: Paths.getRunStateRoot(),
        state_schema: RuntimeIdentity.RUN_STATE_SCHEMA,
        version: RuntimeIdentity.getPackageVersion(),
    };
}
function runtimeRuns(ctx, deps, status, includeNavigation = false) {
    const session = ToolsAccess.requireContextSessionId(ctx, "runtime Run inventory");
    const listed = deps.listRuns
        ? deps.listRuns()
        : AsyncRuns.listRuns(undefined, status);
    const observedFailures = [];
    const runs = listed
        .map((run) => {
        try {
            const observed = deps.getRunStatus
                ? deps.getRunStatus(String(run.state_dir ?? run.run))
                : AsyncRuns.getRunStatus(String(run.state_dir ?? run.run));
            if (includeNavigation && observed.status === "failed" && typeof observed.run === "string" && typeof observed.run_instance_id === "string" &&
                typeof observed.state_dir === "string" && observed.ownerId === session) {
                observedFailures.push({ run: observed.run, run_instance_id: observed.run_instance_id, state_dir: observed.state_dir, ownerId: session });
            }
            return observed;
        }
        catch {
            return run;
        }
    })
        .filter((run) => run.ownerId === session);
    const navigation = includeNavigation ? readRunSessionNavigation(deps.runStateRoot ?? Paths.getRunStateRoot(), session, {
        root_order: status === "failed" ? "failed_subtrees_first" : "latest_registration",
        failed: observedFailures,
    }) : undefined;
    const current = ToolsAccess.requireContextSessionId(ctx, "runtime Run inventory");
    if (current !== session)
        throw ToolsAccess.sessionMismatchError({ currentSession: current, expectedSession: session, target: "runtime" });
    return { owner_session: session, runs, ...(navigation ? { navigation } : {}) };
}
function runtimeTriage(ctx, deps) {
    const inventory = runtimeRuns(ctx, deps, undefined);
    const runs = inventory.runs;
    const failed = runs.filter((run) => run.status === "failed");
    const pendingControls = [];
    const staleControls = [];
    const backpressuredRuns = [];
    const controlDiagnostics = [];
    const traceDiagnostics = [];
    const nowMs = Date.now();
    for (const run of runs) {
        const stateDir = typeof run.state_dir === "string" ? run.state_dir : undefined;
        if (!stateDir)
            continue;
        const runId = String(run.run ?? "unknown");
        const journal = RunsControls.readRunControlJournalFromStateDir(stateDir);
        const capacity = computeRunControlCapacity(journal.records);
        controlDiagnostics.push(...journal.diagnostics.map((diagnostic) => ({
            ...(diagnostic.line === undefined ? {} : { line: diagnostic.line }),
            reason: diagnostic.line === undefined ? "unreadable_control_journal" : "invalid_control_json", run: runId,
        })));
        if (capacity.backpressured)
            backpressuredRuns.push({
                run: runId, pending: capacity.pending, pending_limit: capacity.limit,
                journal_bytes: statSync(RunsControls.runControlsFile(stateDir)).size,
            });
        const traceSummary = RunsTrace.summarizeRunTraceJournal(RunsTrace.readRunTraceJournal(stateDir));
        if (!traceSummary.history_complete)
            traceDiagnostics.push({ run: runId, ...traceSummary });
        for (const control of journal.records) {
            const classified = RuntimeTriage.classifyRuntimeControl({
                run: runId,
                ...(typeof run.run_instance_id === "string"
                    ? { runInstanceId: run.run_instance_id }
                    : {}),
                status: String(run.status ?? "unknown"),
            }, control, nowMs);
            if (classified.pending)
                pendingControls.push(classified.pending);
            if (classified.stale)
                staleControls.push(classified.stale);
            if (classified.diagnostic)
                controlDiagnostics.push({ ...classified.diagnostic });
        }
    }
    const attentionEvents = runs.flatMap((run) => {
        const stateDir = typeof run.state_dir === "string" ? run.state_dir : undefined;
        if (!stateDir)
            return [];
        return RunsTrace.readRunTraceEvents(stateDir)
            .filter((event) => event.attention === "notify" ||
            event.attention === "followup" ||
            event.attention === "steer")
            .map((event) => ({
            run: run.run,
            id: event.id,
            kind: event.kind,
            attention: event.attention,
            summary: event.summary,
            ts: event.ts,
        }));
    });
    const boundedStaleControls = staleControls.slice(0, 40);
    const staleKeys = new Set(boundedStaleControls.map((control) => `${control.run}\0${control.run_instance_id}\0${control.id}`));
    const boundedPendingControls = [
        ...boundedStaleControls,
        ...pendingControls.filter((control) => !staleKeys.has(`${control.run}\0${control.run_instance_id}\0${control.id}`)),
    ].slice(0, 40);
    return {
        ...inventory,
        failed_runs: failed,
        pending_control_count: pendingControls.length,
        pending_controls: boundedPendingControls,
        stale_control_count: staleControls.length,
        stale_controls: boundedStaleControls,
        backpressured_run_count: backpressuredRuns.length, backpressured_runs: backpressuredRuns.slice(0, 40),
        control_diagnostic_count: controlDiagnostics.length, control_diagnostics: controlDiagnostics.slice(0, 40),
        trace_diagnostic_count: traceDiagnostics.length, trace_diagnostics: traceDiagnostics.slice(0, 40),
        attention_events: attentionEvents.slice(-40).reverse(),
        next_actions: [
            ...(failed.length ? ["actors_inspect target=runtime view=runs status=failed"] : []),
            ...new Set([...staleControls, ...backpressuredRuns].slice(0, 3).map((entry) => `actors_inspect target=run:${entry.run} view=control`)),
            ...(attentionEvents.length
                ? attentionEvents.slice(-3).map((entry) => `actors_inspect target=run:${String(entry.run)} view=trace source=runtime`)
                : []),
        ],
    };
}
/** Compact metadata-only documents share the same emitter/omission policy as other receipts. */
function compactDocument(value) {
    return ToolsResponse.compactYamlDocument(value);
}
/** Generated definition metadata is YAML like other owned output; the machine JSON stays in details. */
function schemaDocument(details) {
    // Absent definition fields stay absent exactly as JSON.stringify omitted them; values are native nodes.
    const selected = {};
    for (const key of ["name", "description", "parameters", "promptSnippet"])
        if (details[key] !== undefined)
            selected[key] = details[key];
    // The shared emitter's own execution ceiling is the only wider allowance; a pathological schema
    // keeps the exact legacy JSON text rather than being clipped or partly reformatted.
    const rendered = ToolsResponse.renderYamlMetadata(selected, 49152);
    return rendered.state === "available"
        ? `\n${rendered.text}` : `\n${JSON.stringify(details, null, 2)}`;
}
function compactSelected(key, value) {
    return ToolsResponse.selectYamlField(key, value, Limits.RUN_DELIVERY_MODEL_MAX_BYTES);
}
function compactArguments(key, value) {
    const selected = Array.isArray(value) && value.length
        ? value.map(item => String(item)) : Array.isArray(value) ? "none" : "unknown";
    return ToolsResponse.selectYamlField(key, selected, Limits.RUN_DELIVERY_MODEL_MAX_BYTES);
}
function compactRuntime(view, details) {
    const count = (value) => (Array.isArray(value) ? value.length : 0);
    return compactDocument(view === "runs" ? { runtime: view, runs: count(details.runs) }
        : view === "triage" ? {
            runtime: view, failed: count(details.failed_runs),
            pending_controls: Number(details.pending_control_count ?? 0), stale_controls: Number(details.stale_control_count ?? 0),
            backpressured: Number(details.backpressured_run_count ?? 0), incomplete_trace: Number(details.trace_diagnostic_count ?? 0),
            attention: count(details.attention_events),
        } : { runtime: view, version: String(details.version), state_schema: String(details.state_schema),
            automatic_review: String(details.automatic_review) });
}
// Projects local refusals only; does not intercept other throws or change existing catches.
function formatInspectFailure(fields, next) {
    // The unchanged public adapter replaces this document's trailing LF with its one leading LF.
    const budget = Limits.RUN_DELIVERY_MODEL_MAX_BYTES;
    // Field-local coverage record: an unfit selected scalar/sequence is omitted whole, never clipped.
    const omitted = { state: "omitted", reason: "response_too_large", shown: 0, omitted: 1, total: 1 };
    const render = (value) => {
        const rendered = ToolsResponse.renderYamlMetadata(value, budget);
        return rendered.state === "available" ? rendered.text : undefined;
    };
    const parts = fields.map(([key, value, omittable]) => {
        const full = typeof value === "string" ? { [key]: value } : { [key]: [...value] };
        const fallback = { [key]: omitted };
        // Unmarked fields are bounded compiler literals/lists. Short values seed full so admission only grows.
        const complete = render(full);
        const selected = omittable && (complete === undefined || Buffer.byteLength(complete) > Buffer.byteLength(render(fallback) ?? ""))
            ? fallback : full;
        return { omittable, full, selected };
    });
    // Only producer-known read-only inspect literals become a typed next, never a parsed action.
    const typedNext = next ? { next: { tool: "actors_inspect", target: next[0], view: next[1] } } : undefined;
    const nextFallback = { next_action: omitted };
    const document = () => ({ ...Object.assign({}, ...parts.map((part) => part.selected)),
        ...(typedNext ?? nextFallback) });
    let selectedNext = typedNext;
    if (next && render(document()) === undefined)
        selectedNext = undefined;
    const nextValue = () => (next ? (selectedNext ?? nextFallback) : {});
    for (const part of parts) {
        if (!part.omittable)
            continue;
        const previous = part.selected;
        part.selected = part.full;
        if (render({ ...Object.assign({}, ...parts.map((item) => item.selected)), ...nextValue() }) === undefined)
            part.selected = previous;
    }
    const text = render({ ...Object.assign({}, ...parts.map((item) => item.selected)), ...nextValue() });
    return (text ?? "").replace(/\n$/u, "");
}
function inspectRuntime(view, input, ctx, deps) {
    if (view === "status")
        return runtimeStatus();
    if (view === "runs") {
        return runtimeRuns(ctx, deps, typeof input.status === "string" ? input.status : undefined, input.verbose === true);
    }
    if (view === "triage")
        return runtimeTriage(ctx, deps);
    throw new Error(formatInspectFailure([
        ["target_kind", "runtime"], ["result", "unsupported view"], ["supported_views", ["status", "runs", "triage"]],
    ]));
}
function portableSkillRecipePath(file, skill, namespaces) {
    const root = namespaces[skill]?.[0];
    if (!root)
        return `<active-skill:${skill}>`;
    const relation = relative(root, file);
    return !relation.startsWith("..") && !isAbsolute(relation)
        ? `<active-skill:${skill}>/${relation.replaceAll("\\", "/")}`
        : `<active-skill:${skill}>`;
}
function portableSkillRecipeDiagnosticReason(diagnostic, namespaces) {
    let reason = diagnostic.reason;
    if (diagnostic.file) {
        reason = reason.replaceAll(diagnostic.file, portableSkillRecipePath(diagnostic.file, diagnostic.skill, namespaces));
    }
    for (const root of namespaces[diagnostic.skill] ?? []) {
        reason = reason.replaceAll(root, `<active-skill:${diagnostic.skill}>`);
    }
    return reason;
}
function inspectRecipeIdentity(identity, resolutionContext, namespaces, inventory, registryStatus) {
    const match = /^([a-z][a-z0-9]*(?:-[a-z0-9]+)*)\/([a-z][a-z0-9]*(?:-[a-z0-9]+)*)$/u.exec(identity);
    const skill = match?.[1] ?? "";
    const roots = skill ? namespaces[skill] ?? [] : [];
    const skillActive = roots.length === 1;
    const matchingComponent = inventory.components.find((component) => component.identity === identity);
    const matchingRejection = inventory.rejected.find((diagnostic) => diagnostic.skill === skill &&
        (diagnostic.stem === undefined || diagnostic.stem === match?.[2]));
    let sourceLocation;
    let rejectedReason;
    let resolvable = false;
    if (!match) {
        rejectedReason =
            "Identity must use canonical <skill>/<recipe> syntax.";
    }
    else if (roots.length === 0) {
        rejectedReason = `Active Skill Recipe not found: ${identity}`;
    }
    else if (roots.length > 1) {
        rejectedReason = matchingRejection
            ? portableSkillRecipeDiagnosticReason(matchingRejection, namespaces)
            : `Duplicate active Skill identity ${skill}`;
    }
    else if (matchingRejection) {
        rejectedReason = portableSkillRecipeDiagnosticReason(matchingRejection, namespaces);
        if (matchingRejection.file) {
            sourceLocation = portableSkillRecipePath(matchingRejection.file, skill, namespaces);
        }
    }
    else {
        try {
            const file = RecipesReferences.resolveRecipeReferencePath(identity, resolutionContext?.cwd, resolutionContext?.activeSkills);
            if (!file || !existsSync(file)) {
                rejectedReason = `Skill Recipe component not found: ${identity}`;
            }
            else {
                sourceLocation = portableSkillRecipePath(file, skill, namespaces);
                const recipe = RecipesReferences.readResolvedRecipeConfig(file, [], {
                    skillContext: resolutionContext?.activeSkills,
                });
                if (recipe)
                    resolvable = true;
                else {
                    rejectedReason =
                        RecipesReferences.diagnoseRawRecipeConfigFailure(file) ??
                            `Recipe could not be resolved: ${identity}`;
                }
            }
        }
        catch (error) {
            rejectedReason = error instanceof Error ? error.message : String(error);
        }
    }
    const componentStatus = resolvable
        ? "available"
        : !match
            ? "invalid_identity"
            : roots.length === 0
                ? "skill_inactive"
                : roots.length > 1
                    ? "ambiguous_skill"
                    : matchingRejection
                        ? "rejected"
                        : matchingComponent
                            ? "unresolvable"
                            : "missing";
    return {
        identity,
        skill_active: skillActive,
        resolvable,
        catalog_partial: inventory.partial,
        component_status: componentStatus,
        ...(sourceLocation ? { source_location: sourceLocation } : {}),
        resolution_generation: resolutionContext?.generation ?? registryStatus?.resolution_generation ?? "unavailable",
        ...(rejectedReason ? { rejected_reason: rejectedReason } : {}),
        next_actions: resolvable
            ? [
                `actors_run_spawn recipe=${identity}`,
                `actors_tool_register name=<tool-name> from=${identity}`,
            ]
            : roots.length === 0 && skill
                ? [
                    `activate Skill ${skill}`,
                    `actors_inspect target=recipes view=doctor identity=${identity}`,
                ]
                : ["actors_inspect target=recipes view=imports verbose=true"],
    };
}
function inspectRecipes(requestedView, input, deps, context) {
    // `registry` and `summary` name one inspection path; only `verbose` selects compact versus full output.
    const view = requestedView === "registry" ? "summary" : requestedView;
    if (view !== "status" &&
        view !== "summary" &&
        view !== "doctor" &&
        view !== "imports" &&
        view !== "reviews") {
        throw new Error(formatInspectFailure([
            ["target_kind", "recipes"], ["result", "unsupported view"],
            ["supported_views", ["status", "summary", "registry", "doctor", "imports", "reviews"]],
        ]));
    }
    const recipeRoot = deps.recipeRoot ?? Paths.getRecipeRoot();
    if (view === "reviews") {
        return ReviewDiagnostics.readAutomaticReviewDiagnostics({ recipeRoot });
    }
    const resolutionContext = context && typeof context === "object" && "recipeResolutionContext" in context
        ? context.recipeResolutionContext
        : undefined;
    const activeSkillContext = resolutionContext?.activeSkills ??
        RecipesReferences.EMPTY_ACTIVE_SKILL_RECIPE_CONTEXT;
    const skillRecipeNamespaces = RecipesReferences.getActiveSkillRecipeNamespaces(activeSkillContext);
    const skillInventory = RecipesReferences.inventoryActiveSkillRecipeComponents(activeSkillContext);
    const registryStatus = deps.registryStatus?.();
    const identity = typeof input.identity === "string" ? input.identity.trim() : "";
    if (identity && view !== "doctor") {
        throw new Error(formatInspectFailure([["target_kind", "recipes"], ["result", "identity requires view=doctor"]]));
    }
    if (view === "doctor" && identity) {
        return inspectRecipeIdentity(identity, resolutionContext, skillRecipeNamespaces, skillInventory, registryStatus);
    }
    const skillRecipeComponents = skillInventory.components.map((component) => ({
        identity: component.identity,
        source_kind: "active_skill_component",
        skill: component.skill,
        stem: component.stem,
        imports: component.imports,
    }));
    const skillRecipeComponentDiagnostics = skillInventory.rejected.map((diagnostic) => ({
        error: portableSkillRecipeDiagnosticReason(diagnostic, skillRecipeNamespaces),
        ...(diagnostic.file
            ? {
                file: portableSkillRecipePath(diagnostic.file, diagnostic.skill, skillRecipeNamespaces),
            }
            : {}),
        skill: diagnostic.skill,
        ...(diagnostic.stem ? { stem: diagnostic.stem } : {}),
    }));
    const discovered = RecipesDiscovery.discoverRecipeSources([
        { root: recipeRoot, defaultTool: true, mutableUsage: true, resolutionContext },
    ]);
    const discoverySummary = RecipesDiscovery.summarizeDiscovery(discovered);
    const retained = RecipesDiscovery.inventoryRetainedRecipes(recipeRoot, resolutionContext);
    const summary = {
        ...discoverySummary,
        ...(registryStatus
            ? {
                ...registryStatus,
                watched_root: "~/.pi/agent/recipes",
            }
            : {}),
        active: Array.isArray(discoverySummary.active)
            ? discoverySummary.active.map((entry) => ({
                ...entry,
                source_kind: "user_registry_capability",
            }))
            : discoverySummary.active,
        skill_recipe_components: skillRecipeComponents,
        skill_recipe_component_diagnostics: skillRecipeComponentDiagnostics,
        skill_recipe_catalog_partial: skillInventory.partial,
        active_skill_recipe_identities: Object.keys(skillRecipeNamespaces).sort(),
        skill_recipe_namespace_diagnostics: Object.entries(skillRecipeNamespaces)
            .filter(([, roots]) => roots.length > 1)
            .map(([name]) => ({
            name,
            error: `Ambiguous active Skill Recipe namespace ${name}`,
        })),
        drafts: RecipesDiscovery.listDraftRecipes(join(recipeRoot, "drafts")),
        retained: retained.recipes,
        retained_diagnostics: retained.diagnostics,
    };
    return {
        ...summary,
        next_actions: ToolsResponse.recipeRegistryNextActions(summary, view),
    };
}
function parseRunTarget(target) {
    if (!target.startsWith("run:"))
        return undefined;
    const run = target.slice(4);
    return run && /^[A-Za-z0-9_.-]+$/.test(run) ? run : undefined;
}
function inspectRun(run, view, input, ctx, deps) {
    if (view !== "recipe" && view !== "trace" && view !== "control") {
        throw new Error(formatInspectFailure([
            ["target_kind", "run"], ["result", "unsupported view"], ["supported_views", ["recipe", "trace", "control"]],
        ]));
    }
    const status = deps.getRunStatus
        ? ToolsAccess.assertRunStatusAccessibleToContext(run, deps.getRunStatus(run), ctx)
        : ToolsAccess.assertRunAccessibleToContext(run, ctx);
    const stateDir = String(status.state_dir);
    if (view === "recipe") {
        return Inspector.readActorInspectorRecipe(stateDir);
    }
    if (view === "trace") {
        const source = typeof input.source === "string" ? input.source : "all";
        if (source !== "all" &&
            source !== "lifecycle" &&
            source !== "control" &&
            source !== "process" &&
            source !== "agent" &&
            source !== "artifact" &&
            source !== "runtime") {
            throw new Error(formatInspectFailure([
                ["target_kind", "run"], ["source", source, true], ["result", "unsupported Trace source"],
                ["supported_sources", ["all", "lifecycle", "control", "process", "agent", "artifact", "runtime"]],
            ]));
        }
        return {
            run, source,
            summary: RunsTrace.summarizeRunTraceJournal(RunsTrace.readRunTraceJournal(stateDir)),
            items: TraceProjection.projectRunTrace(stateDir, {
                artifacts: status.artifacts,
                limit: Number(input.lines || Limits.DEFAULT_INSPECT_LINES),
                source,
            }),
        };
    }
    const runInstanceId = String(status.run_instance_id ?? "");
    const journal = RunsControls.readRunControlJournalFromStateDir(stateDir);
    const capacity = computeRunControlCapacity(journal.records);
    const structuralDiagnostics = journal.records.flatMap((value) => {
        const classified = RuntimeTriage.classifyRuntimeControl({ run,
            runInstanceId: runInstanceId || undefined, status: String(status.status ?? "unknown") }, value, Date.now());
        return classified.diagnostic ? [classified.diagnostic.reason] : [];
    });
    let journalBytes = 0;
    try {
        journalBytes = statSync(RunsControls.runControlsFile(stateDir)).size;
    }
    catch { }
    const diagnostics = [...journal.diagnostics.map((item) => ({
            ...(item.line === undefined ? {} : { line: item.line }),
            reason: item.line === undefined ? "unreadable_control_journal" : "invalid_control_json",
        })), ...structuralDiagnostics.map((reason) => ({ reason }))].slice(0, 40);
    const nowMs = Date.now();
    const stalePending = journal.records.reduce((count, control) => count + Number(Boolean(RuntimeTriage.classifyRuntimeControl({ run, runInstanceId: runInstanceId || undefined,
        status: String(status.status ?? "unknown") }, control, nowMs).stale)), 0);
    return {
        run,
        run_instance_id: runInstanceId,
        status: status.status,
        pending: capacity.pending, pending_limit: capacity.limit,
        available: capacity.available, backpressured: capacity.backpressured,
        journal_bytes: journalBytes, journal_limit: Limits.RUN_CONTROL_JOURNAL_MAX_BYTES,
        ...(capacity.oldest_pending_at ? { oldest_pending_at: capacity.oldest_pending_at } : {}),
        stale_pending: stalePending,
        diagnostics,
        actor_actions: Array.isArray(status.control) ? status.control : [],
        runtime_actions: status.status === "running" ? ["kill"] : ["archive", "prune"],
        endpoint: runInstanceId
            ? RunControlDelivery.readRunControlEndpoint(stateDir, runInstanceId)
            : undefined,
        recent_controls: journal.records.slice(-Math.max(1, Number(input.lines || 20))).reverse()
            .map((control) => ControlProjection.projectRunControl(control)),
    };
}
function inspectTool(name, view, deps) {
    if (!name || !/^[A-Za-z0-9_.-]+$/.test(name)) {
        throw new Error(formatInspectFailure([["target", `tool:${name}`, true], ["result", "invalid tool target"]]));
    }
    if (view !== "status" && view !== "schema") {
        throw new Error(formatInspectFailure([
            ["target_kind", "tool"], ["result", "unsupported view"], ["supported_views", ["status", "schema"]],
        ]));
    }
    const tool = deps.getTool?.(name);
    const status = deps.getToolStatus?.(name);
    if (!tool && !status) {
        throw new Error(formatInspectFailure([
            ["tool", name, true], ["result", "registered tool not found"], ["safety", "Do not substitute spawn for tool invocation."],
        ], ["recipes", "doctor"]));
    }
    if (view === "schema" && !tool) {
        throw new Error(formatInspectFailure([
            ["tool", name, true], ["result", "registered; callable schema unavailable"],
            ["callable_now", String(status?.callable_now ?? false), true],
            ["activation_boundary", String(status?.activation_boundary ?? "host_registration"), true],
        ], [`tool:${name}`, "status"]));
    }
    return {
        name,
        ...(view === "status" ? status : {}),
        ...(tool
            ? {
                description: tool.description,
                parameters: tool.parameters,
                promptSnippet: tool.promptSnippet,
            }
            : {}),
    };
}
function compactResult(target, view, details) {
    if (target === "runtime")
        return compactRuntime(view, details);
    if (target === "recipes" && typeof details.identity === "string") {
        const identity = compactSelected("identity", String(details.identity));
        const location = typeof details.source_location === "string"
            ? compactSelected("source_location", details.source_location) : undefined;
        const generation = compactSelected("resolution_generation", String(details.resolution_generation));
        const rejected = typeof details.rejected_reason === "string"
            ? compactSelected("rejected_reason", details.rejected_reason) : undefined;
        const actions = details.next_actions;
        const hint = actions?.length
            ? ToolsResponse.nextActionMetadata(String(actions[0]), Limits.RUN_DELIVERY_MODEL_MAX_BYTES) : undefined;
        const parts = [identity, ...(location ? [location] : []), generation, ...(rejected ? [rejected] : []), ...(hint ? [hint] : [])];
        const render = () => ({ recipes: "doctor", ...identity.selected,
            skill_active: String(details.skill_active), resolvable: String(details.resolvable),
            catalog_partial: String(details.catalog_partial), component_status: String(details.component_status),
            ...(location ? location.selected : {}), ...generation.selected, ...(rejected ? rejected.selected : {}),
            ...(hint ? hint.selected : {}) });
        return `\n${ToolsResponse.growYamlDocument(render, parts, Limits.RUN_DELIVERY_MODEL_MAX_BYTES).replace(/\n$/u, "")}`;
    }
    if (target === "recipes")
        return ToolsResponse.compactRecipeRegistry(details);
    if (target.startsWith("tool:") && view === "status") {
        const name = target.slice(5);
        const tool = compactSelected("tool", name);
        const source = compactSelected("source", String(details.source ?? "unknown"));
        const boundary = compactSelected("activation_boundary", String(details.activation_boundary ?? "unknown"));
        const next = Array.isArray(details.next_actions) && details.next_actions.length > 0
            ? String(details.next_actions[0])
            : details.callable_now === true
                ? `call tool ${name}`
                : `actors_tool_register name=${name} update=true`;
        const hint = ToolsResponse.nextActionMetadata(next, Limits.RUN_DELIVERY_MODEL_MAX_BYTES);
        const required = compactArguments("required_args", details.required_args);
        const optional = compactArguments("optional_args", details.optional_args);
        const render = () => ({ ...tool.selected, ...source.selected,
            callable_now: details.callable_now === true, ...boundary.selected,
            ...required.selected, ...optional.selected,
            launch_kind: String(details.launch_kind ?? "none"),
            spawn_calls: Number(details.spawn_calls ?? 0), tool_calls: Number(details.tool_calls ?? 0),
            ...hint.selected });
        return `\n${ToolsResponse.growYamlDocument(render, [tool, source, boundary, required, optional, hint], Limits.RUN_DELIVERY_MODEL_MAX_BYTES).replace(/\n$/u, "")}`;
    }
    if (target.startsWith("tool:"))
        return compactDocument({ tool: target.slice(5), view });
    return compactDocument({ run: target.slice(4), view });
}
export function createInspectToolDefinition(deps = {}) {
    return {
        name: "actors_inspect",
        label: "Inspect",
        description: "Inspect a Run's Recipe, Trace, or Control evidence, or runtime/recipe/tool diagnostics.",
        parameters: Schema.objectSchema({
            identity: Schema.stringSchema("Optional canonical <skill>/<recipe> identity for focused Recipe doctor diagnosis."),
            lines: Schema.stringSchema("Bounded item count for Trace or recent Controls."),
            source: Schema.stringSchema("Optional Trace source: all, lifecycle, control, process, agent, artifact, or runtime."),
            status: Schema.stringSchema("Optional runtime Run status filter. With verbose runs, failed prioritizes observed failed subtrees without filtering the navigation map."),
            target: Schema.stringSchema("Target: run:<id>, runtime, recipes, or tool:<name>."),
            verbose: Schema.booleanSchema("Return full JSON instead of compact text."),
            view: Schema.stringSchema("Run view recipe|trace|control, or one target-specific management view. runtime status|runs|triage; recipes status|summary|doctor|imports|reviews, where registry aliases summary; tool status|schema."),
        }, ["target", "view"]),
        async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
            const input = asRecord(params);
            const target = String(input.target ?? "");
            const view = String(input.view ?? "");
            let details;
            if (target === "runtime") {
                details = inspectRuntime(view, input, ctx, deps);
            }
            else if (target === "recipes") {
                details = inspectRecipes(view, input, deps, ctx);
            }
            else {
                const run = parseRunTarget(target);
                if (run)
                    details = inspectRun(run, view, input, ctx, deps);
                else if (target.startsWith("tool:")) {
                    details = inspectTool(target.slice(5), view, deps);
                }
                else {
                    throw new Error(formatInspectFailure([
                        ["target", target, true], ["result", "unsupported inspect target"],
                        ["supported_targets", ["run:<id>", "runtime", "recipes", "tool:<name>"]],
                    ]));
                }
            }
            return {
                content: [{
                        type: "text",
                        text: input.verbose === true
                            ? ToolsResponse.jsonText(details)
                            : target.startsWith("tool:") && view === "schema"
                                ? schemaDocument(details)
                                : compactResult(target, view, details),
                    }],
                details,
            };
        },
    };
}
