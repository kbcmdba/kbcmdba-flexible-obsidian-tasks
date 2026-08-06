<!-- SPDX-License-Identifier: GPL-2.0-only -->
# Contributing to Flexible Tasks

Thanks for your interest in improving Flexible Tasks. Bug reports, ideas, and pull requests are all welcome.

## Reporting bugs and requesting features

Open an issue on GitHub: <https://github.com/kbcmdba/kbcmdba-flexible-obsidian-tasks/issues>.

A good bug report includes:

- **Obsidian version** and **operating system**.
- **Checkbox theme** in use (Minimal, default, a snippet, etc.) — status icons are drawn by the theme, so this matters (see [README → Themes](README.md#themes)).
- The **surface**: table cell vs. block list, and **Reading view** vs. **Live Preview**.
- The **raw Markdown** you wrote and what rendered vs. what you expected. A screenshot helps.
- Whether write-back to the `.md` file was correct (the source line/cell that changed).

## Development setup

```bash
npm install
npm run dev     # watch build -> main.js
npm run build   # type-check + production bundle
```

For a live dev loop, symlink this folder into a test vault's plugin directory, enable **Flexible Tasks** in that vault's community-plugin settings, then reload after each build with `Ctrl+P → "Reload app without saving"` (`Ctrl+R` is not bound), or use the Hot-Reload plugin:

```bash
ln -s "$(pwd)" /path/to/TestVault/.obsidian/plugins/flexible-tasks
```

The plugin is developed against the [Minimal](https://minimal.guide/) theme; install it in your test vault to see status icons as intended.

## Architecture notes

Two things are worth knowing before you dig in:

- **Reading view and Live Preview are separate rendering pipelines.** Reading view is post-processed HTML; Live Preview is a CodeMirror 6 editor that owns its DOM. A change often needs handling in both.
- **The plugin defers rendering to your theme.** It puts a real checkbox carrying `data-task="<char>"` in the DOM and gets out of the way — it does not draw its own box or glyph. Please keep new work aligned with that model rather than reintroducing custom-drawn checkboxes.

## Testing

There is a manual UAT plan in [UAT.md](UAT.md) covering both pipelines, table cells, custom statuses, and write-back integrity. Before opening a PR that touches rendering or write-back, run the cases relevant to your change and note the results in the PR description.

The hard rule from the exit criteria: **any write-back that corrupts a table row, drops a label, or writes to the wrong line is a release blocker.** Verify the raw `.md` on disk after your change, not just the rendered view.

## Code style

- **TypeScript**, matching the existing style in `main.ts`.
- `npm run build` must pass (it runs `tsc -noEmit`) with no type errors.
- **No `console.log` in shipped source** — the community-directory review flags it, and it scans source (an esbuild `drop` won't help).
- Keep dependencies minimal; the runtime deps Obsidian provides (`@codemirror/*`) are externalized in `esbuild.config.mjs`.

## Pull requests

1. Fork and branch from `main`.
2. Keep the change focused; one concern per PR.
3. Describe **what changed and why**, and list the UAT cases you ran.
4. Make sure `npm run build` is clean.

## License

Flexible Tasks is licensed under **GPL-2.0-only**. By contributing, you agree that your contributions are licensed under the same terms. Please keep the `SPDX-License-Identifier: GPL-2.0-only` header on new source files.

## Releases (maintainer note)

Releases are cut by the maintainer by pushing a version tag matching `manifest.json` (no leading `v`); CI builds the plugin, attaches build-provenance attestations, and publishes the GitHub release. Contributors do not need to touch `versions.json` or cut releases — just land the code.
