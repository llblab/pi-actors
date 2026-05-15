# Command Template Standard

Command templates are the portable integration format for deterministic local automation.

**Meta-contract:** transportable (bit-for-bit identical across projects), high-density (zero fluff), constant (evolve by crystallizing, not speculating), optimal minimum (add only when it hurts).

**Scope:** portable synchronous command execution format — shell-free exec, composition/pipes, timeout (30s default), delay-before-start, retry, critical-step branching, output artifact selection, and handler-level fallback. Single JSON standard; no platform lock-in.

---

Extensions may choose their own config files, selectors, placeholder sources, and examples, but should preserve this core contract.

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
- `mode`: Optional execution mode for array templates. Default is `"sequence"`; `"parallel"` runs children concurrently.
- `args`: Optional placeholder declarations. Untyped names remain valid; compact typed forms such as `file:path`, `timeout:int`, `speed:number`, `dry_run:bool`, and `mode:enum(check,fix)` are valid when the host supports typed tool schemas. Defaults belong in `defaults` or inline placeholder defaults; hosts may normalize interactive shorthand such as `timeout:int=60000` before persistence.
- `defaults`: Placeholder default values by name.
- `timeout`: Optional execution timeout in milliseconds. Default is `30000`. Long-running agent calls should set this explicitly.
- `delay`: Optional wait in milliseconds before starting this node. Default is no delay.
- `output`: Optional result selector. Default is `"stdout"`; runtime values such as `"ogg"` are valid.
- `retry`: Optional max attempts including the first. Default is `1`.
- `critical`: Optional boolean. When `true`, failure aborts the root composition.
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

| Form             | Meaning                                          |
| ---------------- | ------------------------------------------------ |
| `{name}`         | Required value from runtime values or `defaults` |
| `{name=default}` | Inline default when no value is provided         |

Resolution order is runtime values → `defaults` → inline default → error.

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

Typed declarations annotate the public tool interface, not the shell command. They may live in `args` or inline placeholders such as `{timeout:int=60000}` and `{mode:enum(check,fix)=check}`. Use metadata-first authoring (`args` plus `defaults`) when long templates should stay visually short; use inline-first authoring when one self-contained `template` property is clearer. They do not sandbox or reinterpret the executable; they only let the host generate narrower input schemas and normalize runtime values before placeholder substitution. Untyped `args` and untyped placeholders continue to work unchanged.

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

- Execute leaves in order when `mode` is omitted or set to `"sequence"`
- Execute child templates concurrently when `mode` is set to `"parallel"`
- Parallel composition uses soft-quorum semantics by default: failed non-critical children are reported but do not abort siblings or the next sequence step
- Non-critical failures are recorded and execution continues, while `critical: true` failures abort the root composition
- Treat the whole composition as one handler for selector matching and fallback
- Top-level `args` and `defaults` apply to every leaf unless the leaf defines private values
- Leaf `args` replace inherited `args`; leaf `defaults` merge over inherited defaults; `timeout` and `output` are not inherited into leaves
- Default `30000` (30s) timeout applies automatically; configure `timeout` only for exceptional long-running commands
- Each sequence leaf receives the previous leaf's stdout on stdin by default, while the final leaf stdout remains the default composition result
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

`output` selects the primary result channel. Omitted `output` means `"stdout"`, and explicitly writing `"output": "stdout"` is valid standard syntax. Artifact-producing handlers may instead name a runtime value or placeholder path, e.g. `"ogg"` or `"{ogg}"`.

### Repeat

`repeat` expands one command-template node N times before execution. It works with both sequence and parallel nodes and is useful when many branches differ only by a number.

```json
{
  "mode": "parallel",
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
      "mode": "parallel",
      "template": [
        {
          "label": "gpt-5.5",
          "timeout": 300000,
          "template": "review-gpt {scope}"
        },
        {
          "label": "deepseek-pro",
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
--- branch: gpt-5.5 status: done ---
review text
--- branch: deepseek-pro status: failed ---
exit: 1
stderr: provider balance exhausted
```

Legacy local schemas may accept `pipe` as an alias, but the portable standard is `template: [...]`.

## Fail-Open Default Policy

By default, composition continues on failure: the failed step is logged and the next step executes. This is analogous to `make -k` — the user sees all failures at once and decides what to fix.

## Critical Steps

Set `critical: true` on any leaf to abort the entire root composition on failure. One `critical` leaf can halt the whole pipeline.

```json
{
  "template": [
    { "template": "cargo build" },
    { "template": "cargo fmt --check" },
    { "critical": true, "template": "cargo test" }
  ]
}
```

`build` / `fmt` failures are logged, execution continues. `test` failure aborts the root composition immediately.

A `critical` leaf in a nested composition still aborts the outermost root `template: [...]`. There is no per-branch scoping in the current standard.

## Retry

Set `retry: N` on a leaf to attempt execution up to `N` times (including the first). Retries happen immediately on non-zero exit. The first successful attempt stops the retry loop.

```json
{
  "template": [
    { "retry": 3, "template": "npm install" },
    { "retry": 2, "critical": true, "template": "npm test" }
  ]
}
```

`npm install` is retried up to 3 times. `npm test` is retried up to 2 times; if all attempts fail, the critical step aborts the pipeline.

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
{ mode, template } → sequence or parallel subtree
{ mode, args, defaults, delay, retry, critical, output, template } → full node
```

Start with a string. Add composition when needed. Add `mode: "parallel"` when independent work can run concurrently. Add delay when launch pacing matters. Add retry when flaky. Add critical when safety matters. Same contract, growing capability, no dead weight.

`mode: "parallel"` is the synchronous fanout shape. Detached lifecycle, logs, cancellation, and durable state belong to the separate [Template Job Standard](./template-jobs.md).

## Tool Boundary

Agent tools are a separate abstraction. A tool name is not a portable command template because the pi extension API exposes tool registration metadata, not a public extension-to-extension `executeTool(name, args)` contract. Until such an API exists, extensions should use command templates for deterministic local automation.

## Compatibility

Consumers should share this contract, not private registry fields or implementation details from any specific extension.
