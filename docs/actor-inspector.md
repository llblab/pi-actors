# Actor Inspector

The actor inspector is a manually opened, read-only TUI navigator for owned actor runs. It keeps communication evidence and persisted subagent execution evidence in one hierarchy without merging their meanings.

```text
owned run
  → messages | turns
    → filtered timeline
      → bounded detail
```

## Navigation

`/actors-inspector` opens one centered overlay and remains the only command to remember. The latest run owned by the current Pi session becomes active automatically; an empty session still exposes functional tabs and filters.

The overlay exposes an explicit focus hierarchy:

```text
Run       ←/→ chooses the previous/next owned run, Enter opens runs, ↓ enters tabs
Tabs      ←/→ chooses Messages or Turns, Enter opens filter parameters
Filters   ↑/↓ chooses Channel/State or Subagent, Enter opens values to the right
Values    ↑/↓ hovers, Enter applies, Escape returns one menu level
List      ↑/↓ chooses, Enter/→ opens detail
Detail    ↑/↓ scroll, Enter/→ opens readable transcript, Escape/← returns
Readable  ↑/↓ scroll, Escape/← returns to evidence detail
Escape    Close (or cancel the active options popup)
```

Navigation stays bounded by available actions. `↑` on Run does nothing because no higher control exists. `↓` on Tabs enters the timeline only when it contains rows. Empty timelines therefore never receive focus.

Selection and focus remain separate visual states. Accent-blue text marks the current tab, active filter popup, and applied option. The Run control uses `← … →` markers plus a light neutral background to show both focus and horizontal cycling; menus and timeline rows retain the single `▶` focus marker, while selected tabs retain brackets. Opening a popup keeps its parent filter blue so the relationship remains visible. The footer uses accent color only for key names and arrows; descriptions remain muted.

The top Run control aligns vertically with the tab labels, names the selected owned run, and colors its textual lifecycle status semantically. ←/→ cycles owned runs directly with wraparound, while Enter opens the complete owned-run list immediately beneath the control. That run list starts one cell farther left than the filter menus so its border aligns with the Run control rather than the tab/filter grid. It still overlays the tab row rather than leaving a detached gap. The timeline no longer renders run metadata as a data row.

Filters live behind their tab rather than occupying a permanent row. Non-default filters remain visible as compact parenthesized suffixes in the tab label, so hidden state never silently changes the timeline. Enter on Messages opens `Channel: <current>`, `State: <current>`, and `From: <current>`; `From` draws its values from the selected run's roster and limits rows to one actor. Enter on Turns opens `Subagent: <current>`. Enter on a parameter opens its alternative values as a second menu to the right while the parent and current value remain visible. Parent and child share their touching border rather than leaving or doubling a spacer column. Escape returns one level at a time. Moving focus never applies a value.

Nested menus overlay rather than replace the timeline. Only rows and columns containing menu borders or values occlude underlying cells. When adjacent menus have different heights, the unused corner remains transparent and preserves the separator, striped background, and timeline data beneath it. Every run, filter, and nested value menu is viewport-bounded: ↑/↓ moves through the complete option set, the visible window follows focus, and `↑`/`↓` border markers disclose hidden options above or below without growing past the available inspector rows.

The overlay uses most of the available terminal width and height and reduces its content/menu viewport on shorter terminals. The bordered header keeps both tabs visible, while the list body shows the selected run and its current status above the evidence rows. Run, Message, and Turn lists place the newest retained item directly below their control; a newly opened Inspector therefore selects the latest owned run, and ↓ moves backward in time toward older entries. Run options, Messages, and Turns all use compact descending `#N` labels, providing one timestamp-free time axis without repeating type words on every row. Evidence rows retain stable alternating backgrounds based on their absolute timeline position, including while scrolling: even rows keep the dark overlay background, while odd rows use the neutral `customMessageBg` stripe. Unused viewport padding stays on the plain overlay background instead of drawing fake striped rows beneath the last item. The footer exposes the active keys. Messages retain attention markers and unread filtering and open into bounded detail without leaving the overlay. The overlay refreshes while visible and distinguishes true empty timelines from filtered-empty results; filtered-empty copy points back to Enter on the active tab without moving focus.

## Communication Timeline

The communication timeline reads run-local room, direct, branch-inbox, and coordinator/session message evidence. Rows display their stable `#N` sequence in newest-first order. It preserves channel/sender filters, unread state, attention markers, roster-derived sender options, and bounded body previews. Unread remains filterable but does not consume a row column with a separate dot marker.

Communication evidence describes messages between actors. It does not prove model execution.

## Turns Timeline

Detached child `pi -p` commands receive isolated session storage under their owned run state:

```text
<run-state>/sessions/command-NNN/*.jsonl
```

The runner records direct command-template session files in `review-evidence.json`. Coordinator-managed room/swarm participants also persist role/phase-scoped directories under the same `sessions/` root; the inspector discovers those owned files even though the coordinator, rather than the command-template runner, launched them. Explicit caller session policy (`--no-session`, `--session`, `--session-id`, `--session-dir`, or `--fork`) remains authoritative and is not replaced. A command may therefore have no inspector-visible session.

The turns timeline follows the latest persisted entry branch in each recorded Pi session and displays numbered turns newest-first. Each list row begins with compact `#N`, then a humanized `Subagent N` derived from the internal `command-NNN` session owner, followed by an optional parenthesized semantic stage such as `(reviewer)`. The internal command id remains available in evidence detail for provenance but no longer acts as the unexplained primary list label. The visible model column shows only the model id, not its provider. Tool activity appears as a compact parenthesized action summary such as `(read)`, `(read, bash)`, or `(3 tools)`; `(error)` appears only when the turn or a tool result failed.

Each turn groups:

- User input associated with the response;
- Assistant text and host-persisted thinking blocks;
- Model, stop reason, usage, and error metadata;
- Tool calls in assistant source order;
- Tool results correlated by `toolCallId`, regardless of completion order.

Enter/→ opens the selected turn as structured evidence inside the overlay. A compact `Subagent N` heading with an optional meaningful role leads into meaning-first sections: User, persisted Thinking, Assistant, Tools, Execution, and Diagnostics. A final Provenance section retains session/prompt paths, truncation state, and recipe context without making transport metadata the first screen. Generic internal stages such as `command` and `subagent` stay hidden; technical `command-NNN` provenance remains available through the session and prompt paths without producing a redundant `Command / command-NNN (command)` block. Secondary qualifiers use parentheses rather than centered-dot separators. Long text, paths, and structured values wrap to subsequent terminal rows instead of receiving visual ellipsis; lines that already fit the available inner width remain intact, leading indentation is reserved before wrapping long unbroken paths so it cannot become a whitespace-only row, and every section plus all of its explicit or wrapped continuations keeps one background stripe. Blank-only source lines and trailing line breaks are omitted from both evidence and readable rendering. Section boundaries change the stripe without inserting separator rows, so the next heading follows the previous value immediately. ↑/↓ scrolls the resulting visual-row document while the footer remains visible. Source evidence remains bounded by the persisted session reader, but the detail view no longer truncates that retained evidence to one terminal row per field.

Enter/→ once more opens a plain readable transcript of the same turn. This second level removes provenance, model, usage, ids, and other evidence metadata, retaining only User, Thinking when persisted, Assistant, Tool input/result, and Error content in execution order. When Pi persisted the user prompt as one `<file name="…">…</file>` transport wrapper, readable mode removes that wrapper and shows only its actual prompt text. Structured values render as indented key/value text rather than one-line JSON. Escape/← returns from transcript to evidence detail, then from evidence detail to the Turns list.

## Evidence And Privacy Boundary

The inspector reads file-backed evidence; it does not reconstruct hidden provider reasoning or claim access to data Pi did not persist. When no explicit thinking block exists, Execution reports `thinking: not persisted`.

Session text, communication bodies, and structured values remain bounded. Common secret-bearing keys, camelCase/private-key credentials, serialized JSON credentials, and inline credential patterns are redacted before rendering. Malformed JSONL lines, missing parents, cycles, missing sessions, and incomplete tool correlation remain diagnostic states rather than inferred data.

Ownership filtering happens before run summaries, communication previews, roster data, or session evidence become visible. Selection and read state reset across Pi sessions. Manifest session paths must resolve canonically beneath the selected owned run's `sessions/` directory; absolute paths, traversal, and symlink escapes remain invisible. The inspector never scans another coordinator session's run state into the current view.
