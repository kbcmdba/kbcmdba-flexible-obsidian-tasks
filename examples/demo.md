# Flexible Tasks - demo

Task checkboxes don't work inside Markdown table cells: the format treats a cell
as inline-only, so `- [ ] One` written in a cell is dead text - Obsidian (and
GitHub, as you can see if you view the raw source) never turn it into a checkbox.
**Flexible Tasks** fixes that in Obsidian.

## What it looks like in Obsidian

A little project board where every cell is a real, clickable checkbox (the icons
are drawn by your theme - shown here with Minimal):

<!--
  Why Unicode glyphs instead of real checkboxes in this table:
  GitHub cannot render task checkboxes inside table cells. GFM treats a cell as
  inline-only (so `- [ ]` is literal text), and GitHub's HTML sanitizer strips
  author-written <input> elements - verified against the GitHub /markdown API:
  only a checkbox GitHub itself generates from `- [ ]` in LIST context survives,
  never one in a cell or a hand-written <input>. So this board uses static glyphs
  as a stand-in. Best upgrade is a real screenshot: once docs/board.png exists,
  replace the table below with
      ![Flexible Tasks board in Obsidian](../docs/board.png)
-->

| Today       | This Week       | Someday          |
| :---------- | :-------------- | :--------------- |
| ☐ One       | ◧ Draft PR      | ☐ Learn Rust     |
| ☑ ~~Two~~   | ☐ Review        | ☒ ~~Old idea~~   |
| ◧ Three     | ➤ ~~Deferred~~  | ❓ Maybe         |

> The glyphs above are a static stand-in so this page renders on GitHub. In
> Obsidian these are live checkboxes styled by your theme - **left-click**
> toggles done/to-do, **right-click** sets any status.

## What you write

The source is just ordinary task syntax placed inside table cells:

```markdown
| Today       | This Week      | Someday          |
| :---------- | :------------- | :--------------- |
| - [ ] One   | - [/] Draft PR | - [ ] Learn Rust |
| - [x] Two   | - [ ] Review   | - [-] Old idea   |
| - [/] Three | - [>] Deferred | - [?] Maybe      |
```

Flexible Tasks renders each `- [status]` as an interactive checkbox and writes
your changes back to the file. The status character round-trips faithfully - a
`[/]` stays `[/]` unless you change it.

## Statuses

| Marker | Meaning     | Shown above |
| :----- | :---------- | :---------- |
| `[ ]`  | To do       | ☐           |
| `[x]`  | Done        | ☑           |
| `[/]`  | In progress | ◧           |
| `[-]`  | Cancelled   | ☒           |
| `[>]`  | Forwarded   | ➤           |
| `[?]`  | Question    | ❓          |
| `[!]`  | Important   | ❗          |

Any other single character works too, and shows with the **Important** indicator
so an unplanned status stands out instead of quietly looking done.
