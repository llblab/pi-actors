# Command Template Standard

Command templates are the portable integration format for deterministic local automation.

**Meta-contract:** transportable (bit-for-bit identical across projects), high-density (zero fluff), constant (evolve by crystallizing, not speculating), optimal minimum (add only when it hurts).

**Scope:** portable synchronous command execution format — shell-free exec, composition/pipes, optional timeout, delay-before-start, bounded retry, failure propagation, recover cleanup, output artifact selection, and handler-level fallback. Single JSON standard; no platform lock-in.

---

Extensions may choose their own config files, selectors, placeholder sources, and examples, but should preserve this core contract.

Layer boundary: command templates own only the synchronous execution graph. Recipe imports, import-reference expressions, recipe lookup, `async: true`, run ids, state dirs, mailbox controls, and actor-message routing are host/recipe/async-run configuration layers, not portable command-template syntax.

## Layer Ownership

Command-template standard owns:

- Command string splitting and direct argv execution.
- Placeholder resolution, typed public args, defaults, `??`, ternary string selection, and array-index placeholders.
- Synchronous graph shape: sequence, `parallel`, `when`, `repeat`, stdin flow, stdout joins, and output selection.
- Per-node execution controls: `timeout`, `delay`, `retry`, `failure`, and `recover`.

Command-template standard does not own:

- Where templates are stored or how they are named.
- Recipe imports, import references, or file lookup.
- Detached lifecycle, run ids, state dirs, logs, cancellation, mailbox controls, or actor-message routing.
- Registry metadata such as tool descriptions, package install paths, or operator policy.

## Shape

A command template is either a command-line string or an ordered array of command-template leaves:

```json
{
  "template": "/path/to/stt --file {file} --lang {lang=ru}"
}
```

When the surrounding schema already implies a command template, the compact string form is equivalent:

```json
"/path/to/stt --file {file} --lang {lang=ru}"
```

There is no portable `command` field. The command is derived from `template`: after splitting, the first word is the executable and the remaining words are argv args. Templates do not infer flags: `{file}` is one positional arg; `--file {file}` is a flag arg plus its value.

Common object fields:

- `label`: Optional human label for diagnostics and parallel branch reports.
- `parallel`: Optional boolean for array templates. Default is `false` for sequence; `true` runs children concurrently.
- `when`: Optional node guard. A false guard skips the node; strings may be `flag`, `!flag`, or `{flag?yes:no}` style expressions.
- `args`: Optional placeholder declarations. Untyped names remain valid; compact typed forms such as `file:path`, `request_timeout:int`, `speed:number`, `dry_run:bool`, `prompts:array`, and `mode:enum(check,fix)` are valid when the host supports typed tool schemas. Defaults belong in `defaults` or inline placeholder defaults; hosts may normalize interactive shorthand such as `request_timeout:int=60000` before persistence.
- `defaults`: Placeholder default values by name.
- `timeout`: Optional execution timeout in milliseconds. Omit it, or set `0`, to leave the command unbounded. Set an explicit positive timeout when a tool must fail closed instead of waiting indefinitely. Numeric control fields may be literal numbers or placeholders such as `"{timeout_ms}"`.
- `delay`: Optional wait in milliseconds before starting this node. Default is no delay. It may be a literal number or placeholder.
- `output`: Optional result selector. Default is `"stdout"`; runtime values such as `"ogg"` are valid.
- `retry`: Optional max attempts including the first. Default is `1`.
- `failure`: Optional failure propagation scope: `continue`, `branch`, or `root`. Default is `continue`.
- `recover`: Optional command template run between failed retry attempts. Recovery output is ignored; recovery failure stops retries.
- `template`: Required command string or ordered composition array.

For object form, write `template` last. Read the node flags first, then the executable content. Storage paths, labels, selectors, descriptions, and registry-specific metadata belong to each extension's local schema.

## Execution

A runtime must:

1. Split the template into shell-like words with simple single quotes, double quotes, and backslash escapes
2. Substitute placeholders inside each split word
3. Execute command + args directly, without shell evaluation
4. Treat exit code `0` as success and non-zero as failure
5. Use stdout as the default result channel and stderr only for diagnostics

Implementations may expand `~` in command position and may resolve relative command paths against the caller cwd.

## Placeholders

Supported forms:

| Form               | Meaning                                          |
| ------------------ | ------------------------------------------------ |
| `{name}`           | Required value from runtime values or `defaults` |
| `{name=default}`   | Inline default when no value is provided         |
| `{name??fallback}` | Fallback when value is missing, null, or empty   |
| `{name?yes:no}`    | Ternary string selected by truthiness of `name`  |
| `{items[index]}`   | Array item selected by literal or repeat index   |

Resolution order is runtime values → `defaults` → inline default → error. Nullish coalescing and ternary conditions treat missing, empty, `false`, `0`, and `no` as false. Use `??` for value fallback and ternaries for small string selection such as optional CLI flags; larger policy branches should stay in recipes, scripts, or separate template nodes. Default values that are themselves a single placeholder, such as `{prompt}` resolving to `{prompts[index]}`, are resolved recursively with a small depth guard. A repeat node may set `repeat` to `{items.length}` when an array arg should determine fanout width.

```json
{
  "template": "/path/to/tts --text {text} --lang {lang=ru} --rate {rate=+30%}"
}
```

With runtime values `{ "text": "hello" }`, argv is:

```text
["--text", "hello", "--lang", "ru", "--rate", "+30%"]
```

Use `defaults` for visible configuration data; use inline defaults for compact local literals. Prefer flag-style examples such as `/path/to/tool --file {file} --lang {lang=ru}` for readability, but positional forms such as `/path/to/tool {file} {lang=ru}` are valid when the invoked script defines that CLI contract.

Fallback values can be selected with nullish coalescing:

```json
{
  "template": "deploy --env {env??dev} --region {region??local}"
}
```

Optional flags can be mapped from boolean args with a ternary:

```json
{
  "args": ["target:path", "all:bool"],
  "defaults": { "all": "true" },
  "template": "validate-recipe {target} {all?--all:}"
}
```

Typed declarations annotate the public tool interface, not the shell command. They may live in `args` or inline placeholders such as `{request_timeout:int=60000}` and `{mode:enum(check,fix)=check}`. Use metadata-first authoring (`args` plus `defaults`) when long templates should stay visually short; use inline-first authoring when one self-contained `template` property is clearer. They do not sandbox or reinterpret the executable; they only let the host generate narrower input schemas and normalize runtime values before placeholder substitution. Untyped `args` and untyped placeholders continue to work unchanged.

Node control fields can also read public args. Use distinct arg names so execution controls stay visually separate from public inputs:

```json
{
  "args": ["timeout_ms:int"],
  "timeout": "{timeout_ms}",
  "template": "npm test"
}
```

## Quoting

Placeholder values are not shell-escaped because no shell is used. A value containing spaces remains one argv item when it replaces one split word:

```text
template="echo {text}"
text="hello world"
args=["hello world"]
```

A placeholder may also be embedded inside one word:

```text
template="/path/to/tool --file={file}"
file="/tmp/a b.ogg"
args=["--file=/tmp/a b.ogg"]
```

Use quotes only for literal template words that should contain spaces before placeholder substitution:

```text
template="echo 'literal words' {text}"
```

## Composition

`template: [...]` means sequential composition by default; each leaf is a command template executed with one shared runtime value map:

```json
{
  "template": [
    "/path/to/tts --text {text} --lang {lang=ru} --out {mp3}",
    "ffmpeg -y -i {mp3} -c:a libopus {ogg}"
  ],
  "output": "ogg"
}
```

Composition rules:

- Execute leaves in order when `parallel` is omitted or `false`
- Execute child templates concurrently when `parallel` is `true`
- Parallel composition uses soft-quorum semantics by default: failed children are reported as degraded branches unless failure propagation escalates
- Non-critical failures are recorded and execution continues, while `failure: "branch"` stops the current branch and `failure: "root"` aborts the root composition
- Treat the whole composition as one handler for selector matching and fallback
- Top-level `args` and `defaults` apply to every leaf unless the leaf defines private values
- Leaf `args` replace inherited `args`; leaf `defaults` merge over inherited defaults; `timeout` and `output` are not inherited into leaves
- Timeout is disabled by default; configure a positive `timeout` for bounded commands that should fail closed
- Each sequence leaf receives the previous leaf's stdout on stdin by default, while the final leaf stdout remains the default composition result
- Skipped nodes preserve current stdin/stdout flow and do not execute commands
- Each parallel child receives the same stdin, and child stdout values are joined in stable array order before flowing to the next sequence leaf
- Parallel branch joins include branch label and status, and tool details include branch metadata plus coverage summary
- Each leaf still applies its own inline defaults

```json
{
  "template": [
    "/path/to/tts --text {text} --lang {lang} --out {mp3}",
    {
      "defaults": { "codec": "libopus" },
      "template": "ffmpeg -y -i {mp3} -c:a {codec} {ogg}"
    }
  ],
  "args": ["text", "lang", "mp3", "ogg"],
  "defaults": { "lang": "en" },
  "output": "ogg"
}
```

`output` selects the primary result channel. Omitted `output` means `"stdout"`, and explicitly writing `"output": "stdout"` is valid standard syntax. Artifact-producing handlers may instead name a runtime value or placeholder path, e.g. `"ogg"` or `"{ogg}"`. Do not use `artifacts` in command-template nodes; named artifact manifests belong to the template-recipe layer.

### Repeat

`repeat` expands one command-template node N times before execution. It works with both sequence and parallel nodes and is useful when many branches differ only by a number.

```json
{
  "parallel": true,
  "repeat": 8,
  "template": "render page{_(index+1)}.html --prev page{_(prev+1)}.html --next page{_(next+1)}.html --zero page{_index}.html"
}
```

Reserved repeat placeholders are injected into each repeated node:

- `{index}`: current zero-based index, `0..repeat-1`
- `{prev}` / `{next}`: wrapped zero-based neighbors
- `{repeat}`: total repeat count

Human 1-based numbering is intentionally expressed as limited arithmetic: `{index+1}`, `{prev+1}`, `{next+1}`.

Leading underscores on repeat placeholders request zero padding. One underscore means width 2, two underscores mean width 3, and so on:

```text
{_index}      → 00, 01, ...
{_(index+1)}  → 01, 02, ...
{__(index+1)} → 001, 002, ...
{_(prev+1)}   → wrapped previous page number, padded to width 2
{_(next+1)}   → wrapped next page number, padded to width 2
```

Repeat expressions support only integers, `index`, `prev`, `next`, `repeat`, parentheses, and `+`, `-`, `*`, `/`, `%`. They are not JavaScript and cannot call functions or access properties.

Repeat placeholders are local generated values. Call-time args should not use these reserved names to override the repeat index.

Parallel nodes use the same object shape. Flags come first and `template` stays last:

```json
{
  "template": [
    "prepare {out_dir}",
    {
      "parallel": true,
      "template": [
        {
          "label": "reviewer-a",
          "timeout": 300000,
          "template": "review-gpt {scope}"
        },
        {
          "label": "reviewer-b",
          "timeout": 300000,
          "template": "review-deepseek {scope}"
        },
        {
          "label": "kimi",
          "timeout": 300000,
          "template": "review-kimi {scope}"
        }
      ]
    },
    "merge {out_dir}"
  ]
}
```

A degraded parallel join is still usable when at least one branch succeeds:

```text
--- branch: reviewer-a status: done ---
review text
--- branch: reviewer-b status: failed ---
exit: 1
stderr: provider balance exhausted
```

Some local schemas may accept `pipe` as an alias, but the portable standard is `template: [...]`.

## Fail-Open Default Policy

By default, composition continues on failure: the failed step is logged and the next step executes. This is analogous to `make -k` — the user sees all failures at once and decides what to fix.

## Failure Propagation

By default, failed steps use `failure: "continue"`: record the failure, clear stdout for that step, and continue the current sequence. This preserves the fail-open profile.

Use `failure` when a node should stop more aggressively:

- `"continue"`: record the failure and continue the current sequence.
- `"branch"`: stop the current sequence/subtree and return a failed branch to the nearest parent. In a parallel node, sibling branches keep running and the join becomes degraded. At the root, branch failure is still a tool failure.
- `"root"`: abort the outermost composition.

```json
{
  "parallel": true,
  "template": [
    {
      "label": "agent-a",
      "failure": "branch",
      "template": [
        "agent-a-work {scope}",
        "agent-a-validate {scope}",
        "agent-a-push {scope}"
      ]
    },
    {
      "label": "agent-b",
      "failure": "branch",
      "template": [
        "agent-b-work {scope}",
        "agent-b-validate {scope}",
        "agent-b-push {scope}"
      ]
    }
  ]
}
```

If `agent-a-validate` fails, `agent-a-push` is skipped, `agent-b` can still finish, and the parallel join reports degraded branch coverage.

## Retry

Set `retry: N` to attempt execution up to `N` times including the first. The first successful attempt stops the retry loop.

On leaf commands, retry repeats that command. On sequence or parallel nodes, retry repeats the whole node. A retried group only retries when the group returns a failure, so validator checkpoints normally pair group retry with `failure: "branch"` or `failure: "root"`.

```json
{
  "failure": "branch",
  "retry": 3,
  "template": ["implement {scope}", "npm test", "git diff --check"]
}
```

Here the whole group runs again when a validator fails. Without `failure: "branch"`, the failed validator would be logged and the group would continue by default.

## Recover

Set `recover` on a retried node to run cleanup after a failed attempt and before the next attempt. `recover` is another command template: it can be a string command, sequence, or parallel tree. Its output is ignored and the next retry receives the original stdin.

```json
{
  "failure": "branch",
  "retry": 3,
  "recover": "git -C {work_dir} reset --hard HEAD",
  "template": ["pi -p --tools read,edit,bash {scope_file}", "npm test"]
}
```

`recover` is not a fallback success path. It is cleanup between attempts. Practical uses include resetting a worktree, removing temp files, clearing generated output, releasing a local lock, or stopping a helper process before trying the node again. If recovery fails, retries stop and the recovery failure is returned. Recovery uses fail-closed semantics by default; set an explicit `failure` inside a recover template only when a softer cleanup failure is intentional.

## Conditional Nodes

Set `when` to skip a node unless a boolean condition is true. This is node-level branching, not placeholder text selection. It is useful for optional validation, artifact, or reporting steps.

```json
{
  "template": [
    "prepare {target}",
    { "when": "run_tests", "template": "npm test" },
    { "when": "!run_tests", "template": "echo tests skipped" }
  ]
}
```

Falsy values are missing, empty, `false`, `0`, and `no`. In a sequence, a skipped node preserves the previous stdout for the next step. In a parallel branch, a skipped node succeeds with empty branch output.

## Delay

Set `delay` to wait before starting a node. The value is milliseconds. Delay is not inherited into child nodes, just like `timeout`.

```json
{
  "template": [
    "prepare {scope}",
    { "delay": 1000, "template": "review {scope}" }
  ]
}
```

On a sequence node, `delay` waits before the sequence begins. On a parallel node, `delay` waits before launching its children. On a branch, `delay` waits before that branch starts, without blocking sibling branches.

Use `delay` only for explicit backoff, rate pacing, or staged launch. Do not use it as a scheduler.

## Progressive Disclosure

The standard uses a single `template` field that grows with the user's needs:

```text
string           → leaf command
string[]         → sequential composition
{ template }     → leaf command object
{ parallel, template } → sequence or parallel subtree
{ parallel, when, args, defaults, delay, retry, failure, recover, output, template } → full node
```

Start with a string. Add composition when needed. Add `parallel: true` when independent work can run concurrently. Add `when` when a node is conditional. Add delay when launch pacing matters. Add retry when flaky. Add `failure` when propagation scope matters. Add `recover` when a retried node needs cleanup before another attempt. Same contract, growing capability, no dead weight.

`parallel: true` is the synchronous fanout shape. Saved JSON belongs to the separate [Template Recipe Standard](./template-recipes.md); detached lifecycle, logs, cancellation, and durable state belong to the separate [Async Run Standard](./async-runs.md).

## Trust Boundary

Command templates avoid shell interpolation by splitting the template into argv first and substituting placeholders per arg. A placeholder value containing spaces remains one argv value, not a shell fragment.

This is not a sandbox. The executable still runs with the same user permissions as the host agent. Shells, interpreter eval modes, destructive filesystem commands, and local scripts remain trusted code. Examples that deserve extra operator attention:

- `bash`, `sh`, `zsh`, or `fish`, especially with `-c`.
- `node -e`, `python -c`, `ruby -e`, `perl -e`, or similar eval modes.
- `rm`, `mv`, `cp`, or `rsync` over broad paths or placeholder-derived paths.

Hosts may surface lightweight warnings for these obvious high-risk shapes. Warnings should inform review without blocking existing tools, because many trusted local wrappers intentionally use shells or filesystem mutation.

## Tool Boundary

Agent tools are a separate abstraction. A tool name is not a portable command template because the pi extension API exposes tool registration metadata, not a public extension-to-extension `executeTool(name, args)` contract. Until such an API exists, extensions should use command templates for deterministic local automation.

## Compatibility

Consumers should share this contract, not private registry fields or implementation details from any specific extension.
