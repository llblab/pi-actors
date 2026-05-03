# Command Template Standard

Command templates are the stable integration format for local automation.

This is a portable standard: extensions may adapt examples and local placeholder sources, but should preserve the contract below to stay compatible with the shared command-template model.

A command template is a command line string with named placeholders. `pi-auto-tools` turns it into a callable agent tool by mapping tool parameters onto those placeholders and executing the result directly through `pi.exec`.

## Contract

A command template is a single string:

```text
~/bin/transcribe {file} {lang}
```

The runtime must:

1. Split the template into shell-like words, honoring simple single quotes, double quotes, and backslash escapes
2. Substitute placeholders inside each split word
3. Execute the first word as the command and the remaining words as argv
4. Avoid evaluating the template through a shell
5. Treat exit code `0` as success and non-zero exit as failure
6. Use stdout as the result channel
7. Use stderr only for diagnostics

`pi-auto-tools` expands `~` only in the command position. Relative command paths are resolved by `pi.exec` against the active cwd.

## Placeholders

Every declared arg creates one placeholder with the same normalized name:

```text
args="file,lang=ru,model=voxtral-mini-latest"
template="~/bin/transcribe {file} {lang} {model}"
```

Missing required placeholder values become empty strings only if the tool schema allowed the call to omit them. Defaults are applied before substitution.

## File argument naming

For tools that accept a local file path, use `file` as the canonical argument name:

```text
register_tool name=transcribe_mistral \
  template="~/.agents/skills/mistral-stt/scripts/transcribe.sh {file} {lang} {model}" \
  args="file,lang=ru,model=voxtral-mini-latest"
```

Avoid using `filename` for full paths. `filename` usually means a basename/display name, while `file` can represent a concrete local file path.

## Quoting model

Placeholder values are not shell-escaped because templates are not executed through a shell. A value containing spaces remains one argv item when it replaces one split word:

```text
template="echo {text}"
text="hello world"
argv=["hello world"]
```

A placeholder can also be embedded inside one word:

```text
template="tool --file={file}"
file="/tmp/a b.ogg"
argv=["--file=/tmp/a b.ogg"]
```

Use quotes only for literal template words that should contain spaces before placeholder substitution:

```text
template="echo 'literal words' {text}"
```

## Relation to agent tools

Agent tools are the callable interface exposed to the LLM. Command templates are the storage and execution contract used by `pi-auto-tools` to implement those tools. Other extensions should depend on this command-template standard only when they intentionally execute local commands; they should not parse `auto-tools.json` as a universal tool invocation API.
