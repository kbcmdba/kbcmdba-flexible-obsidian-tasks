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
- Test with the default theme and a theme with alternative checkboxes, such as Minimal. The active theme supplies the colors, glyphs, and strikethrough.

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

| Char | Meaning     | Theme status requested |
| ---- | ----------- | ---------------------- |
| ` `  | To do       | Unchecked              |
| `x`  | Done        | Done                   |
| `/`  | In progress | In progress            |
| `-`  | Cancelled   | Cancelled              |
| `>`  | Forwarded   | Forwarded              |
| `?`  | Question    | Question               |
| `!`  | Important   | Important              |
| `@`  | Arbitrary   | Important              |

`@` is the "any single char round-trips" promise — it must render and persist even
though it's not in the right-click menu.

## 4. Test cases

Mark each Result P (pass) / F (fail) / N/A. A failing case should name the one thing wrong.

### A. Reading view — block tasks

| ID | Steps | Expected | Result |
|----|-------|----------|--------|
| A1 | Switch fixture to **Reading** view | Every block task shows the active theme's native checkbox styling | |
| A2 | `[@]` arbitrary task | Theme receives the Important status. The source still contains `[@]` | |
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
| B2 | `[x]` / `[/]` / `[@]` cells | The theme draws the checkbox. The hover label reports the actual status | |
| B3 | Left-click the `[ ]` cell box | Toggles to done; **correct table row/column** rewritten on disk | |
| B4 | Right-click a cell box → "Cancelled" | Theme draws the Cancelled status. Disk cell becomes `- [-] ...` | |
| B5 | Non-task cells (Status/Notes columns) | Rendered normally, no box, text intact | |
| B6 | Header row | No box injected into the header | |
| B7 | Tab to a checkbox and press Space | The checkbox toggles and the marker is updated on disk | |

### C. Live Preview — block tasks

| ID | Steps | Expected | Result |
|----|-------|----------|--------|
| C1 | Switch to **Live Preview** | Each block task shows Obsidian's native checkbox | |
| C2 | Glyphs & strikethrough | Match the active theme's Live Preview styling | |
| C3 | Click a box | Toggles done↔to-do; change persists to disk | |
| C4 | Right-click a block task line | Checkbox choices appears in the editor context menu. Selecting a status rewrites the marker | |
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
| F1 | Turn "Style block-list tasks too" **OFF** | Reading view removes the extra block-task menu. Table checkboxes stay interactive | |
| F2 | With it OFF, check LP | Obsidian still renders its native block-task checkboxes | |
| F3 | Turn it back **ON** | The Reading view block-task menu returns without an app reload | |

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
| H3 | Two task lines with identical text | Toggling one changes only that source line | |
| H4 | A very long note; scroll so tasks leave/enter the viewport (LP) | Boxes re-render correctly on scroll (CM6 viewport) | |

## 5. Exit criteria

- **Must pass:** all of A, B, C, E; F1–F3; G1–G3, G5. These are the shipping promises (tables + custom statuses + faithful write-back + both pipelines).
- **Expected N/A / known-limitation:** D1–D2 (LP tables), G4 done→to-do landing on `[ ]`. Log these as *known limitations*, not bugs.
- **Any write-back that corrupts a table row, drops a label, or writes to the wrong line is a release blocker.**

## 6. Known limitations (do not file as bugs)

- Task checkboxes **inside tables are not decorated in Live Preview** yet — only Reading view. (Next feature.)
- Left-click on a done task returns it to `[ ]`, not to a prior custom status.
- One task per body cell. Existing inline markup in the label remains usable.

## 7. Isolated dashboard regressions

Build and create a fresh fixture vault from the repository root.

```bash
npm ci
npm test
npm run build
audit_root="$(npm run --silent test:vault)"
```

The generated vault opens `Dashboard.md` in Reading view. It includes 9 academic years, 65 fictional exam sessions, and 260 table checkboxes. If you install Dataview and enable JavaScript queries in the test vault, the summary should show 65 exams, 260 exercises, and 65 completed exercises. The first checkbox should take the completed count to 66. The separate Tasks query should show the ordinary synthetic reminder.

Launch a dedicated desktop process with `--user-data-dir="$audit_root/profile"` and `--remote-debugging-port=49382` to run the automated desktop cases. On macOS, use the executable inside `Obsidian.app/Contents/MacOS`. The runner requires Node 22 or newer, checks the fixture vault path, and writes only to those synthetic notes. Reuse the same profile across the three phases and generate a fresh vault before repeating the sequence.

```bash
node tests/obsidian.mjs 49382 "$audit_root/vault" startup
node tests/obsidian.mjs 49382 "$audit_root/vault" exercise
# Quit the dedicated Obsidian process and start it again with the same profile.
node tests/obsidian.mjs 49382 "$audit_root/vault" restored
```

For a manual pass, open the dashboard directly in Reading view from a cold start, scroll through all nine sections, then open `Issue 2.md` in Live Preview and switch the pane back to Reading. Toggle each cell and inspect the file. Open `Edge.md` for the escaped pipe, duplicate markers, fenced example, quote, custom status, and formatted label. Check the context menus, open two panes on the same note, edit from one pane, and reopen the dashboard after quitting the app.
