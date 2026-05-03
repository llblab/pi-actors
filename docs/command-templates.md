# Command Template Standard

Command templates are the stable integration format for deterministic local automation.

This document is the portable core. Extensions may adapt local examples, placeholder sources, and config locations, but should preserve this contract to stay compatible with the shared command-template model.

## Definition

A command template is a single command-line string with named placeholders:

```text
~/bin/transcribe {file} {lang}
```

## Execution Contract

The runtime must:

1. Split the template into shell-like words, honoring simple single quotes, double quotes, and backslash escapes
2. Substitute placeholders inside each split word
3. Execute the first word as the command and the remaining words as args
4. Avoid evaluating the template through a shell
5. Treat exit code `0` as success and non-zero exit as failure
6. Use stdout as the result channel
7. Use stderr only for diagnostics

Implementations may expand `~` in the command position and may resolve relative command paths against the caller cwd.

## Quoting Model

Placeholder values are not shell-escaped because templates are not executed through a shell. A value containing spaces remains one command arg when it replaces one split word:

```text
template="echo {text}"
text="hello world"
args=["hello world"]
```

A placeholder can also be embedded inside one word:

```text
template="tool --file={file}"
file="/tmp/a b.ogg"
args=["--file=/tmp/a b.ogg"]
```

Use quotes only for literal template words that should contain spaces before placeholder substitution:

```text
template="echo 'literal words' {text}"
```

## Storage Vocabulary

JSON storage is part of the standard vocabulary, but not one universal schema. Extensions may store command templates in different config files and surrounding shapes.

Common field names:

| Field      | Meaning                                                                                    |
| ---------- | ------------------------------------------------------------------------------------------ |
| `template` | Command-line template string, usually attached to a named capability or handler            |
| `args`     | Declared placeholder names, represented as a string or array according to the local schema |
| `defaults` | Object mapping placeholder names to default values                                         |

Config file locations, selectors, labels, descriptions, and surrounding registry shapes belong to each extension's local adaptation.

## Tool Boundary

Agent tools are a separate abstraction. A tool name is not a portable command template because the pi extension API currently exposes tool registration and metadata, but not a public extension-to-extension `executeTool(name, args)` call.

Until such an API exists, extensions should prefer command templates for deterministic local automation.

## Compatibility

Consumers should share this template contract, not private registry fields or implementation details from any specific extension.
