<!-- SPDX-License-Identifier: GPL-2.0-only -->
# Flexible Tasks — UAT Plan

User Acceptance Testing for the task-checkbox plugin. Goal: confirm the two
things that justify the plugin — **task checkboxes inside table cells** and
**custom statuses that round-trip faithfully** — work across both of Obsidian's
rendering pipelines, and that nothing is silently lost on write-back.

## 1. Preconditions

- Obsidian ≥ 1.4.0, plugin installed & enabled (test vault is fine).
- **Reload after each build:** `Ctrl+P → "Reload app without saving"` (Ctrl+R is not bound).
- Settings → Flexible Tasks → "Style block-list tasks too" = **ON** (default) unless a case says otherwise.
- Have a file manager / terminal open to inspect the raw `.md` on disk (write-back verification).
- Test in **both** themes if possible (default light + one dark) — the boxes use theme accent vars.

## 2. Fixture note

Create a note with exactly this content and use it for every case below.

```markdown
# UAT fixture

## Block tasks
- [ ] to-do block task
- [x] done block task
- [/] in-progress block task
- [-] cancelled block task
- [>] forwarded block task
- [?] question block task
- [!] important block task
- [@] arbitrary-char block task
- [ ] parent with subtasks
    - [ ] indented subtask one
    - [x] indented subtask two

Not a task - a plain bullet:
- just a bullet, no checkbox

## Table tasks
| Task              | Status  | Notes         |
| ----------------- | ------- | ------------- |
| - [ ] table to-do | open    | first cell    |
| - [x] table done  | closed  | second row    |
| - [/] table wip   | working | third row     |
| - [@] table custom| odd     | arbitrary char|
```

## 3. Statuses under test

| Char | Meaning       | Box shows | Label struck? |
| ---- | ------------- | --------- | ------------- |
| ` `  | To do         | empty     | no            |
| `x`  | Done          | ✓         | **yes**       |
| `/`  | In progress   | `/`       | no            |
| `-`  | Cancelled     | `-`       | **yes**       |
| `>`  | Forwarded     | `>`       | **yes**       |
| `?`  | Question      | `?`       | no            |
| `!`  | Important     | `!`       | no            |
| `@`  | Arbitrary     | `@`       | no            |

`@` is the "any single char round-trips" promise — it must render and persist even
though it's not in the right-click menu.

## 4. Test cases

Mark each Result P (pass) / F (fail) / N/A. A failing case should name the one thing wrong.

### A. Reading view — block tasks

| ID | Steps | Expected | Result |
|----|-------|----------|--------|
| A1 | Switch fixture to **Reading** view | Every block task shows a status box with the correct glyph per §3; `x`,`-`,`>` labels struck | |
| A2 | `[@]` arbitrary task | Box shows `@`; label not struck | |
| A3 | Left-click the `[ ]` to-do box | Toggles to done (✓, struck); disk line becomes `- [x] ...` | |
| A4 | Left-click a `[x]` done box | Toggles to `[ ]` to-do (empty, unstruck) on disk | |
| A5 | Right-click any box | Status menu lists To do/Done/In progress/Cancelled/Forwarded/Question/Important with current one checked | |
| A6 | Right-click → pick "In progress" | Box shows `/`; disk line `- [/] ...` | |
| A7 | Parent-with-subtasks: toggle the parent | Only the parent line changes; subtasks untouched (box + disk) | |
| A8 | "just a bullet" line | No box, rendered as an ordinary bullet | |

### B. Reading view — table cells (the headline feature)

| ID | Steps | Expected | Result |
|----|-------|----------|--------|
| B1 | Reading view, table section | Each task cell shows a box + label (not raw `- [ ] ...` text) | |
| B2 | `[x]` / `[/]` / `[@]` cells | Correct glyph; `x` struck, `/` and `@` not | |
| B3 | Left-click the `[ ]` cell box | Toggles to done; **correct table row/column** rewritten on disk | |
| B4 | Right-click a cell box → "Cancelled" | Box shows `-`, label struck; disk cell `- [-] ...` | |
| B5 | Non-task cells (Status/Notes columns) | Rendered normally, no box, text intact | |
| B6 | Header row | No box injected into the header | |

### C. Live Preview — block tasks

| ID | Steps | Expected | Result |
|----|-------|----------|--------|
| C1 | Switch to **Live Preview** | Block tasks show our boxes; **no leftover native Obsidian checkbox** beside them (incl. `/`,`?`,`@`) | |
| C2 | Glyphs & strikethrough | Match §3 (custom chars visible in the box) | |
| C3 | Click a box | Toggles done↔to-do; change persists to disk | |
| C4 | Right-click a box | Status menu appears; picking a status rewrites the marker | |
| C5 | Put the **text cursor on a task line** | That line reverts to raw `- [ ] ...` text (editable); other lines keep their boxes | |
| C6 | Type to edit a task's label text | No crash/fl/ box re-renders correctly after moving the cursor away | |
| C7 | Indented subtasks | Boxes render at the right indent; toggling one hits the right disk line | |

### D. Live Preview — tables — KNOWN LIMITATION (verify graceful, not broken)

Tables in Live Preview are **not yet** handled (Obsidian renders those with its own
table editor). These cases confirm we don't make them *worse*, not that they work.

| ID | Steps | Expected | Result |
|----|-------|----------|--------|
| D1 | Live Preview, table section | Task cells show Obsidian's default (raw `- [ ]` text / native handling); **no plugin crash, no console errors** | |
| D2 | Switch that same table to Reading view | Boxes appear correctly (proves §B still works after LP) | |

### E. Source mode — editor right-click submenu

| ID | Steps | Expected | Result |
|----|-------|----------|--------|
| E1 | Source mode, right-click on a block-task line | Context menu has a **"Checkbox choices"** submenu | |
| E2 | Submenu → pick a status | The `[ ]` marker on that line is rewritten | |
| E3 | Right-click a table task row (source) | Submenu present and targets the marker nearest the click | |
| E4 | Right-click a non-task line | No "Checkbox choices" submenu (not offered) | |

### F. Settings toggle

| ID | Steps | Expected | Result |
|----|-------|----------|--------|
| F1 | Turn "Style block-list tasks too" **OFF** | Reading & LP: block tasks revert to Obsidian's native rendering; **table cells still get boxes** (tables are the core feature, not gated) | |
| F2 | With it OFF, check LP | Native checkbox reappears (our hide-native CSS is off) — no orphaned/hidden checkbox | |
| F3 | Turn it back **ON** | Block-task boxes return without a reload | |

### G. Persistence & cross-pipeline consistency

| ID | Steps | Expected | Result |
|----|-------|----------|--------|
| G1 | Toggle a task in Reading view, switch to LP | LP reflects the new status | |
| G2 | Toggle in LP, switch to Reading | Reading reflects it | |
| G3 | After several toggles, inspect the raw `.md` on disk | Only the intended markers changed; **table pipes/columns intact**, labels intact, no stray chars | |
| G4 | Set a `[@]` via editing text, then toggle it done and back | Round-trips to `[@]`? (Note: left-click done→to-do goes to `[ ]`, not back to `@` — confirm that's acceptable) | |
| G5 | Close & reopen the note | All statuses render from disk as expected | |

### H. Edge cases

| ID | Steps | Expected | Result |
|----|-------|----------|--------|
| H1 | Task label containing a `|` pipe **outside** a table | Renders/persists without breaking the label | |
| H2 | Empty label (`- [x]` with nothing after) | Box renders; no crash | |
| H3 | Two task lines with identical text | Toggling one changes only that line (DOM-index → source-line mapping holds) | |
| H4 | A very long note; scroll so tasks leave/enter the viewport (LP) | Boxes re-render correctly on scroll (CM6 viewport) | |

## 5. Exit criteria

- **Must pass:** all of A, B, C, E; F1–F3; G1–G3, G5. These are the shipping promises (tables + custom statuses + faithful write-back + both pipelines).
- **Expected N/A / known-limitation:** D1–D2 (LP tables), G4 done→to-do landing on `[ ]`. Log these as *known limitations*, not bugs.
- **Any write-back that corrupts a table row, drops a label, or writes to the wrong line is a release blocker.**

## 6. Known limitations (do not file as bugs)

- Task checkboxes **inside tables are not decorated in Live Preview** yet — only Reading view. (Next feature.)
- Left-click on a done task returns it to `[ ]`, not to a prior custom status.
- One task per cell; inline Markdown inside a task label is not specially handled.
