# Table of Tasks

An [Obsidian](https://obsidian.md) plugin that makes task checkboxes work **inside Markdown table cells** — something the format doesn't support natively.

## Why

A Markdown table cell is inline-only, so a task like `- [ ] One` written inside a cell renders as dead text; Obsidian never turns it into a checkbox, and task plugins skip it. This plugin renders those cell tasks as real, interactive checkboxes and writes toggles back to the source file.

## Status

**v0.1.0 - early MVP.** Reading view only.

- [x] Interactive checkboxes in table cells (reading view)
- [x] Open status set - `[ ]`, `[x]`, `[/]`, `[-]`, `[>]`, `[?]`, `[!]`, and any other single character round-trip faithfully
- [x] Left-click toggles done <-> to-do (model A)
- [x] Right-click to set any status
- [ ] Live Preview (editor) support
- [ ] Column-level checkboxes
- [ ] Multiple tasks per cell
- [ ] Inline Markdown in task labels (bold/links)

## Usage

Write a table whose cells contain tasks:

```markdown
| Today       | This Week      | Someday        |
| :---------- | :------------- | :------------- |
| - [ ] One   | - [/] Draft    | - [ ] Learn Go |
| - [x] Two   | - [ ] Review   | - [-] Old idea |
```

In reading view each `- [ ]` becomes a clickable checkbox. Left-click completes it; right-click opens a menu to set any status.

## Task status behavior (model A)

- **Left-click** toggles between done (`[x]`) and to-do (`[ ]`) - the same as checkboxes everywhere else in Obsidian.
- **Right-click** opens a menu to set any status directly.
- Custom statuses render with a small badge and set `data-task="<char>"`, so themes that style `[data-task]` apply on top.

## Development

```bash
npm install
npm run dev     # watch build -> main.js
npm run build   # type-check + production bundle
```

For a live dev loop, symlink this folder into a test vault's plugin directory:

```bash
ln -s "$(pwd)" /path/to/TestVault/.obsidian/plugins/table-of-tasks
```

Then enable **Table of Tasks** in the vault's community-plugin settings and use "Reload app" (or the Hot-Reload plugin) after each build.

## License

GPL-2.0-only. See [LICENSE](LICENSE).
