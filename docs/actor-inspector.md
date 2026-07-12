# Actor Inspector

The actor inspector is a manually opened, read-only TUI navigator for owned actor runs. It keeps communication evidence and persisted subagent execution evidence in one hierarchy without merging their meanings.

```text
owned run
  → messages | turns
    → filtered timeline
      → bounded detail
```

## Navigation

`/actors-inspector-toggle` opens one centered overlay and remains the only command to remember. The first run owned by the current Pi session becomes the active run automatically; an empty session still exposes functional tabs and filters.

The overlay exposes an explicit focus hierarchy:

```text
Run       Enter opens owned runs, ↓ enters tabs
Tabs      ←/→ chooses Messages or Turns, Enter opens filter parameters
Filters   ↑/↓ chooses Channel/State or Subagent, Enter opens values to the right
Values    ↑/↓ hovers, Enter applies, Escape returns one menu level
List      ↑/↓ chooses, Enter/→ opens detail
Detail    ↑/↓ scroll, Escape/← returns
Escape    Close (or cancel the active options popup)
```

Navigation stays bounded by available actions. `↑` on Run does nothing because no higher control exists. `↓` on Tabs enters the timeline only when it contains rows. Empty timelines therefore never receive focus.

Selection and focus remain separate visual states. Accent-blue text marks the current tab, active filter popup, and applied option. A light neutral background plus `▶` marks every selectable control or timeline row that currently owns keyboard focus. Opening a popup keeps its parent filter blue so the relationship remains visible. The footer uses accent color only for key names and arrows; descriptions remain muted.

The top Run control aligns vertically with the tab labels, names the selected owned run, and colors its textual lifecycle status semantically. Enter opens available owned runs immediately beneath it, overlaying the tab row rather than leaving a detached gap. The timeline no longer renders run metadata as a data row.

Filters live behind their tab rather than occupying a permanent row. Non-default filters remain visible as compact suffixes in the tab label, so hidden state never silently changes the timeline. Enter on Messages opens `Channel: <current>`, `State: <current>`, and `From: <current>`; `From` draws its values from the selected run's roster and limits rows to one actor. Enter on Turns opens `Subagent: <current>`. Enter on a parameter opens its alternative values as a second menu to the right while the parent and current value remain visible. Parent and child share their touching border rather than leaving or doubling a spacer column. Escape returns one level at a time. Moving focus never applies a value.

Nested menus overlay rather than replace the timeline. Only rows and columns containing menu borders or values occlude underlying cells. When adjacent menus have different heights, the unused corner remains transparent and preserves the separator, striped background, and timeline data beneath it.

The overlay uses most of the available terminal width and height. The bordered header keeps both tabs visible, while the list body shows the selected run and its current status above the evidence rows. Evidence rows retain stable alternating backgrounds based on their absolute timeline position, including while scrolling: even rows keep the dark overlay background, while odd rows use the neutral `customMessageBg` stripe. The footer exposes the active keys. Messages retain attention markers and unread filtering and open into bounded detail without leaving the overlay. The overlay refreshes while visible and distinguishes true empty timelines from filtered-empty results; filtered-empty copy points back to Enter on the active tab without moving focus.

## Communication Timeline

The communication timeline reads run-local room, direct, branch-inbox, and coordinator/session message evidence. It preserves channel/sender filters, unread state, attention markers, roster-derived sender options, and bounded body previews. Unread remains filterable but does not consume a row column with a separate dot marker.

Communication evidence describes messages between actors. It does not prove model execution.

## Turns Timeline

Detached child `pi -p` commands receive isolated session storage under their owned run state:

```text
<run-state>/sessions/command-NNN/*.jsonl
```

The runner records direct command-template session files in `review-evidence.json`. Coordinator-managed room/swarm participants also persist role/phase-scoped directories under the same `sessions/` root; the inspector discovers those owned files even though the coordinator, rather than the command-template runner, launched them. Explicit caller session policy (`--no-session`, `--session`, `--session-id`, `--session-dir`, or `--fork`) remains authoritative and is not replaced. A command may therefore have no inspector-visible session.

The turns timeline follows the latest persisted entry branch in each recorded Pi session and groups:

- User input associated with the response;
- Assistant text and host-persisted thinking blocks;
- Provider, model, stop reason, usage, and error metadata;
- Tool calls in assistant source order;
- Tool results correlated by `toolCallId`, regardless of completion order.

Enter opens the selected turn inside the overlay. Detail adds command/stage identity, session and prompt paths, recipe-context reference, tool arguments/results, truncation state, unmatched result counts, and parse diagnostics. ↑/↓ scroll long detail while the footer keeps return/close keys visible.

## Evidence And Privacy Boundary

The inspector reads file-backed evidence; it does not reconstruct hidden provider reasoning or claim access to data Pi did not persist. When no explicit thinking block exists, detail shows `reasoning unavailable`.

Session text, communication bodies, and structured values remain bounded. Common secret-bearing keys, camelCase/private-key credentials, serialized JSON credentials, and inline credential patterns are redacted before rendering. Malformed JSONL lines, missing parents, cycles, missing sessions, and incomplete tool correlation remain diagnostic states rather than inferred data.

Ownership filtering happens before run summaries, communication previews, roster data, or session evidence become visible. Selection and read state reset across Pi sessions. Manifest session paths must resolve canonically beneath the selected owned run's `sessions/` directory; absolute paths, traversal, and symlink escapes remain invisible. The inspector never scans another coordinator session's run state into the current view.
