/**
 * Public inspect tool behavior.
 * Zones: Run Recipe/Trace/Control views and runtime/recipe/tool diagnostics
 * Owns exact inspect target/view dispatch; source projection stays in domain modules.
 */

import { join } from "node:path";

import * as AsyncRuns from "./async-runs.ts";
import * as Inspector from "./inspector.ts";
import * as Limits from "./limits.ts";
import * as Paths from "./paths.ts";
import * as RecipesDiscovery from "./recipes-discovery.ts";
import * as ReviewDiagnostics from "./review-diagnostics.ts";
import * as RunsControls from "./runs-controls.ts";
import * as RunControlDelivery from "./runs-control-delivery.ts";
import * as RunsTrace from "./runs-trace.ts";
import * as Schema from "./schema.ts";
import * as ToolsAccess from "./tools-access.ts";
import * as ToolsResponse from "./tools-response.ts";
import * as TraceProjection from "./trace-projection.ts";

const asRecord = ToolsResponse.asRecord;
const maybeJsonText = ToolsResponse.maybeJsonText;

export interface InspectToolDeps<TContext = unknown> {
  getRunStatus?: (runOrDir: string) => Record<string, any>;
  getTool?: (name: string) => any | undefined;
  listRuns?: () => Array<Record<string, any>>;
  packagedRecipeRoot?: string;
  recipeRoot?: string;
}

function runtimeStatus(): Record<string, unknown> {
  return {
    automatic_review: process.env.PI_ACTORS_AUTOMATIC_REVIEW !== "off",
    run_root: Paths.getRunStateRoot(),
    version: process.env.npm_package_version ?? "unknown",
  };
}

function runtimeRuns(
  ctx: unknown,
  deps: InspectToolDeps,
  status: string | undefined,
): Record<string, unknown> {
  const session = ToolsAccess.getContextSessionId(ctx);
  const listed = deps.listRuns
    ? deps.listRuns()
    : AsyncRuns.listRuns(undefined, status);
  const runs = listed
    .map((run) => {
      try {
        return deps.getRunStatus
          ? deps.getRunStatus(String(run.state_dir ?? run.run))
          : AsyncRuns.getRunStatus(String(run.state_dir ?? run.run));
      } catch {
        return run;
      }
    })
    .filter((run) => !session || !run.ownerId || run.ownerId === session);
  return { ...(session ? { owner_session: session } : {}), runs };
}

function runtimeTriage(
  ctx: unknown,
  deps: InspectToolDeps,
): Record<string, unknown> {
  const inventory = runtimeRuns(ctx, deps, undefined);
  const runs = inventory.runs as Array<Record<string, unknown>>;
  const failed = runs.filter((run) => run.status === "failed");
  const staleControls = runs.flatMap((run) => {
    const stateDir = typeof run.state_dir === "string" ? run.state_dir : undefined;
    if (!stateDir) return [];
    return RunsControls.readRunControlsFromStateDir(stateDir)
      .filter((control) => control.status === "queued" || control.status === "claimed")
      .map((control) => ({ run: run.run, control }));
  });
  const attentionEvents = runs.flatMap((run) => {
    const stateDir = typeof run.state_dir === "string" ? run.state_dir : undefined;
    if (!stateDir) return [];
    return RunsTrace.readRunTraceEvents(stateDir)
      .filter((event) => event.attention === "notify" || event.attention === "followup")
      .map((event) => ({
        run: run.run,
        id: event.id,
        kind: event.kind,
        attention: event.attention,
        summary: event.summary,
        ts: event.ts,
      }));
  });
  return {
    ...inventory,
    failed_runs: failed,
    stale_controls: staleControls.slice(0, 40),
    attention_events: attentionEvents.slice(-40).reverse(),
    next_actions: [
      ...(failed.length ? ["inspect target=runtime view=runs status=failed"] : []),
      ...(staleControls.length
        ? staleControls.slice(0, 3).map((entry) =>
            `inspect target=run:${String(entry.run)} view=control`,
          )
        : []),
      ...(attentionEvents.length
        ? attentionEvents.slice(-3).map((entry) =>
            `inspect target=run:${String(entry.run)} view=trace source=runtime`,
          )
        : []),
    ],
  };
}

function compactRuntime(view: string, details: Record<string, unknown>): string {
  if (view === "runs") {
    return `\nruntime runs=${(details.runs as unknown[] | undefined)?.length ?? 0}`;
  }
  if (view === "triage") {
    return `\nruntime failed=${(details.failed_runs as unknown[] | undefined)?.length ?? 0} stale_controls=${(details.stale_controls as unknown[] | undefined)?.length ?? 0} attention=${(details.attention_events as unknown[] | undefined)?.length ?? 0}`;
  }
  return `\nruntime version=${String(details.version ?? "unknown")} automatic_review=${String(details.automatic_review)}`;
}

function inspectRuntime(
  view: string,
  input: Record<string, unknown>,
  ctx: unknown,
  deps: InspectToolDeps,
): Record<string, unknown> {
  if (view === "status") return runtimeStatus();
  if (view === "runs") {
    return runtimeRuns(
      ctx,
      deps,
      typeof input.status === "string" ? input.status : undefined,
    );
  }
  if (view === "triage") return runtimeTriage(ctx, deps);
  throw new Error("inspect runtime supports view=status, view=runs, or view=triage.");
}

function inspectRecipes(
  view: string,
  deps: InspectToolDeps,
): Record<string, unknown> {
  if (
    view !== "status" &&
    view !== "summary" &&
    view !== "doctor" &&
    view !== "imports" &&
    view !== "reviews"
  ) {
    throw new Error(
      "inspect recipes supports view=status, view=summary, view=doctor, view=imports, or view=reviews.",
    );
  }
  const recipeRoot = deps.recipeRoot ?? Paths.getRecipeRoot();
  if (view === "reviews") {
    return ReviewDiagnostics.readAutomaticReviewDiagnostics({ recipeRoot });
  }
  const discovered = RecipesDiscovery.discoverRecipeSources([
    { root: recipeRoot, defaultTool: true, mutableUsage: true },
    { root: deps.packagedRecipeRoot ?? Paths.getPackagedRecipeRoot() },
  ]);
  const summary = {
    ...RecipesDiscovery.summarizeDiscovery(discovered),
    drafts: RecipesDiscovery.listDraftRecipes(join(recipeRoot, "drafts")),
  };
  return {
    ...summary,
    next_actions: ToolsResponse.recipeRegistryNextActions(summary, view),
  };
}

function parseRunTarget(target: string): string | undefined {
  if (!target.startsWith("run:")) return undefined;
  const run = target.slice(4);
  return run && /^[A-Za-z0-9_.-]+$/.test(run) ? run : undefined;
}

function inspectRun(
  run: string,
  view: string,
  input: Record<string, unknown>,
  ctx: unknown,
  deps: InspectToolDeps,
): Record<string, unknown> {
  if (view !== "recipe" && view !== "trace" && view !== "control") {
    throw new Error("inspect run:<id> supports view=recipe, view=trace, or view=control.");
  }
  const status = deps.getRunStatus
    ? deps.getRunStatus(run)
    : ToolsAccess.assertRunAccessibleToContext(run, ctx);
  const stateDir = String(status.state_dir);
  if (view === "recipe") {
    return Inspector.readActorInspectorRecipe(stateDir) as unknown as Record<string, unknown>;
  }
  if (view === "trace") {
    const source = typeof input.source === "string" ? input.source : "all";
    if (
      source !== "all" &&
      source !== "lifecycle" &&
      source !== "control" &&
      source !== "process" &&
      source !== "agent" &&
      source !== "artifact" &&
      source !== "runtime"
    ) {
      throw new Error(`unsupported Trace source: ${source}`);
    }
    return {
      run,
      source,
      items: TraceProjection.projectRunTrace(stateDir, {
        artifacts: status.artifacts as
          | Record<string, AsyncRuns.RunArtifactDeclaration>
          | undefined,
        limit: Number(input.lines || Limits.DEFAULT_INSPECT_LINES),
        source,
      }),
    };
  }
  const runInstanceId = String(status.run_instance_id ?? "");
  return {
    run,
    run_instance_id: runInstanceId,
    status: status.status,
    actor_actions: Array.isArray(status.control) ? status.control : [],
    runtime_actions: status.status === "running" ? ["kill"] : ["archive", "prune"],
    endpoint: runInstanceId
      ? RunControlDelivery.readRunControlEndpoint(stateDir, runInstanceId)
      : undefined,
    recent_controls: RunsControls.readRunControlsFromStateDir(stateDir)
      .slice(-Math.max(1, Number(input.lines || 20)))
      .reverse(),
  };
}

function inspectTool(
  name: string,
  view: string,
  deps: InspectToolDeps,
): Record<string, unknown> {
  if (!name || !/^[A-Za-z0-9_.-]+$/.test(name)) {
    throw new Error(`invalid tool target: tool:${name}`);
  }
  if (view !== "status" && view !== "schema") {
    throw new Error("inspect tool:<name> supports view=status or view=schema.");
  }
  const tool = deps.getTool?.(name);
  if (!tool) throw new Error(`registered tool not found: ${name}`);
  return {
    name,
    description: tool.description,
    parameters: tool.parameters,
    promptSnippet: tool.promptSnippet,
  };
}

function compactResult(target: string, view: string, details: Record<string, unknown>): string {
  if (target === "runtime") return compactRuntime(view, details);
  if (target === "recipes") return ToolsResponse.compactRecipeRegistry(details);
  if (target.startsWith("tool:")) return `\ntool=${target.slice(5)} view=${view}`;
  return `\nrun=${target.slice(4)} view=${view}`;
}

export function createInspectToolDefinition<TContext = unknown>(
  deps: InspectToolDeps<TContext> = {},
): any {
  return {
    name: "inspect",
    label: "Inspect",
    description:
      "Inspect a Run's Recipe, Trace, or Control evidence, or runtime/recipe/tool diagnostics.",
    parameters: Schema.objectSchema(
      {
        lines: Schema.stringSchema("Bounded item count for Trace or recent Controls."),
        source: Schema.stringSchema(
          "Optional Trace source: all, lifecycle, control, process, agent, artifact, or runtime.",
        ),
        status: Schema.stringSchema("Optional runtime Run status filter."),
        target: Schema.stringSchema("Target: run:<id>, runtime, recipes, or tool:<name>."),
        verbose: Schema.booleanSchema("Return full JSON instead of compact text."),
        view: Schema.stringSchema(
          "Run view recipe|trace|control, or target-specific management view.",
        ),
      },
      ["target", "view"],
    ),
    async execute(
      _toolCallId: string,
      params: unknown,
      _signal: AbortSignal | undefined,
      _onUpdate: unknown,
      ctx: TContext,
    ) {
      const input = asRecord(params);
      const target = String(input.target ?? "");
      const view = String(input.view ?? "");
      let details: Record<string, unknown>;
      if (target === "runtime") {
        details = inspectRuntime(view, input, ctx, deps);
      } else if (target === "recipes") {
        details = inspectRecipes(view, deps);
      } else {
        const run = parseRunTarget(target);
        if (run) details = inspectRun(run, view, input, ctx, deps);
        else if (target.startsWith("tool:")) {
          details = inspectTool(target.slice(5), view, deps);
        } else {
          throw new Error(
            `unsupported inspect target: ${target}; use run:<id>, runtime, recipes, or tool:<name>`,
          );
        }
      }
      return {
        content: [{
          type: "text" as const,
          text: maybeJsonText(
            details,
            input.verbose === true || (target.startsWith("tool:") && view === "schema"),
            compactResult(target, view, details),
          ),
        }],
        details,
      };
    },
  };
}
