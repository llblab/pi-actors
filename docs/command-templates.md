# Command Template Standard

Command templates are the portable integration format for deterministic local automation. Extensions may choose their own config files, selectors, placeholder sources, and examples, but should preserve this core contract.

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

| Field      | Meaning                                                                                                               |
| ---------- | --------------------------------------------------------------------------------------------------------------------- |
| `template` | Required command string or ordered composition array                                                                  |
| `args`     | Optional placeholder-name declarations only; never stores defaults                                                    |
| `defaults` | Placeholder default values by name                                                                                    |
| `timeout`  | Optional execution timeout in milliseconds                                                                            |
| `output`   | Optional result selector; default is `"stdout"`, artifact-producing handlers may name a runtime value such as `"ogg"` |

Storage paths, labels, selectors, descriptions, and registry-specific metadata belong to each extension's local schema.

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

`template: [...]` means sequential composition; each leaf is a command template executed with one shared runtime value map:

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

- Execute leaves in order and stop on the first non-zero exit
- Treat the whole composition as one handler for selector matching and fallback
- Top-level `args` and `defaults` apply to every leaf unless the leaf defines private values
- Leaf `args` replace inherited `args`; leaf `defaults` merge over inherited defaults; `timeout` and `output` are not inherited into leaves
- Top-level `timeout` wraps the whole sequence; leaf `timeout` applies only to that leaf within the remaining total budget
- Each leaf receives the previous leaf's stdout on stdin by default, while the final leaf stdout remains the default composition result
- Each leaf still applies its own inline defaults

```json
{
  "template": [
    "/path/to/tts --text {text} --lang {lang} --out {mp3}",
    {
      "template": "ffmpeg -y -i {mp3} -c:a {codec} {ogg}",
      "defaults": { "codec": "libopus" }
    }
  ],
  "args": ["text", "lang", "mp3", "ogg"],
  "defaults": { "lang": "en" },
  "output": "ogg"
}
```

`output` selects the primary result channel. Omitted `output` means `"stdout"`, and explicitly writing `"output": "stdout"` is valid standard syntax. Artifact-producing handlers may instead name a runtime value or placeholder path, e.g. `"ogg"` or `"{ogg}"`.

Legacy local schemas may accept `pipe` as an alias, but the portable standard is `template: [...]`.

## Tool Boundary

Agent tools are a separate abstraction. A tool name is not a portable command template because the pi extension API exposes tool registration metadata, not a public extension-to-extension `executeTool(name, args)` contract. Until such an API exists, extensions should use command templates for deterministic local automation.

## Compatibility

Consumers should share this contract, not private registry fields or implementation details from any specific extension.
