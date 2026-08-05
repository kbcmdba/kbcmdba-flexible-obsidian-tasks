// SPDX-License-Identifier: GPL-2.0-only

import {
	App,
	Editor,
	Plugin,
	PluginSettingTab,
	Setting,
	Menu,
	Notice,
	TFile,
	MarkdownView,
	editorLivePreviewField,
} from "obsidian";
import { Prec, RangeSetBuilder } from "@codemirror/state";
import {
	Decoration,
	DecorationSet,
	EditorView,
	ViewPlugin,
	ViewUpdate,
	WidgetType,
} from "@codemirror/view";

/** A table cell whose text is a task: list marker, [status] box, optional label. */
const TASK_CELL_RE = /^\s*[-*+]\s+\[(.)\]\s*(.*)$/;
/** A block-list task line in the source (any indentation). */
const TASK_LINE_RE = /^\s*[-*+]\s+\[.\]/;
/** A block-list task at the start of a line, capturing the marker prefix and status. */
const TASK_PREFIX_RE = /^(\s*[-*+]\s+)\[(.)\]/;

/** Statuses offered in the right-click menu. Rendering supports any character. */
const MENU_STATUSES: ReadonlyArray<{ char: string; label: string }> = [
	{ char: " ", label: "To do" },
	{ char: "x", label: "Done" },
	{ char: "/", label: "In progress" },
	{ char: "-", label: "Cancelled" },
	{ char: ">", label: "Forwarded" },
	{ char: "?", label: "Question" },
	{ char: "!", label: "Important" },
];

const isDone = (c: string): boolean => c === "x" || c === "X";

/** Statuses that strike through the label (finished or abandoned work). */
const STRIKETHROUGH = new Set(["x", "X", "-", ">"]);
const isStruck = (c: string): boolean => STRIKETHROUGH.has(c);

/** Flip to enable verbose console diagnostics during development. */
const DEBUG = true;
const dlog = (...args: unknown[]): void => {
	if (DEBUG) console.log("[FT]", ...args);
};

interface TableOfTasksSettings {
	styleBlockTasks: boolean;
}
const DEFAULT_SETTINGS: TableOfTasksSettings = {
	styleBlockTasks: true,
};

export default class TableOfTasksPlugin extends Plugin {
	settings: TableOfTasksSettings = DEFAULT_SETTINGS;
	private scanQueued = false;

	async onload() {
		await this.loadSettings();
		this.addSettingTab(new TableOfTasksSettingTab(this.app, this));

		// Obsidian hands markdown post-processors DETACHED section fragments that
		// may not contain the table, so we don't process through them. Instead we
		// use render/layout events as a trigger and scan the attached reading-view
		// containers directly.
		this.registerMarkdownPostProcessor(() => this.queueScan());
		this.registerEvent(
			this.app.workspace.on("layout-change", () => this.queueScan())
		);
		this.registerEvent(
			this.app.workspace.on("active-leaf-change", () => this.queueScan())
		);
		// Editor (Live Preview / source) right-click: add a status submenu, since
		// the editor owns its context menu and our in-DOM boxes can't intercept it.
		this.registerEvent(
			this.app.workspace.on("editor-menu", (menu, editor) =>
				this.addStatusSubmenu(menu, editor)
			)
		);
		this.app.workspace.onLayoutReady(() => this.queueScan());

		// Live Preview: reading-view DOM injection doesn't work there (CM6 owns and
		// rebuilds the editor DOM), so we render the boxes with a CodeMirror editor
		// extension instead. Prec.highest so our replace decoration wins over
		// Obsidian's own Live Preview checkbox over the same [status] marker.
		this.registerEditorExtension(Prec.highest(livePreviewBoxes(this)));

		// Prec.highest suppresses Obsidian's native LP checkbox only for statuses it
		// renders the same way (space/x); for custom statuses (/, ?, ...) its
		// checkbox still leaks through. We're replacing it with our own box anyway,
		// so hide the native one via a body class while block styling is on.
		this.updateNativeCheckboxHiding();
	}

	onunload() {
		document.body.removeClass("tot-hide-native-checkbox");
	}

	/** Toggle the body class that hides Obsidian's native Live Preview checkbox. */
	private updateNativeCheckboxHiding() {
		document.body.toggleClass(
			"tot-hide-native-checkbox",
			this.settings.styleBlockTasks
		);
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings() {
		await this.saveData(this.settings);
		this.updateNativeCheckboxHiding();
		this.queueScan();
	}

	/** Coalesce bursts of triggers into a single deferred scan. */
	private queueScan() {
		if (this.scanQueued) return;
		this.scanQueued = true;
		window.setTimeout(() => {
			this.scanQueued = false;
			this.scanReadingViews();
		}, 50);
	}

	private scanReadingViews() {
		for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
			const view = leaf.view;
			if (!(view instanceof MarkdownView)) continue;
			// Boxes render in READING view only. In the editor (Live Preview /
			// source) we leave Obsidian's native checkboxes in place and offer the
			// "Checkbox choices" submenu instead - injecting our boxes into the
			// editor's CM6 DOM is what was blocking that submenu from working.
			if (view.getMode() !== "preview") continue;

			// Task cells inside tables. Headers and already-decorated cells no
			// longer contain "- [ ] ..." text, so they simply won't match.
			view.contentEl
				.querySelectorAll<HTMLTableCellElement>("td, th")
				.forEach((cell) => {
					const match = (cell.textContent ?? "").match(TASK_CELL_RE);
					if (!match) return;
					const table = cell.closest("table");
					if (!table) return;
					this.decorateCell(cell, match[1], (match[2] ?? "").trim(), view, table);
				});

			// Block-list tasks outside tables (opt-in).
			if (this.settings.styleBlockTasks) {
				view.contentEl
					.querySelectorAll<HTMLLIElement>("li.task-list-item")
					.forEach((li) => this.decorateListItem(li, view));
			}
		}
	}

	// --- Table cells -------------------------------------------------------

	private decorateCell(
		cell: HTMLTableCellElement,
		status: string,
		label: string,
		view: MarkdownView,
		table: HTMLTableElement
	) {
		cell.empty();
		const wrap = cell.createDiv({ cls: "tot-task" });
		wrap.dataset.task = status;
		if (isStruck(status)) wrap.addClass("is-struck");

		const box = wrap.createSpan({ cls: "tot-box" });
		this.paintBox(box, status);

		wrap.createSpan({ cls: "tot-task-label", text: label });

		box.addEventListener("click", async (evt) => {
			evt.preventDefault();
			const current = wrap.dataset.task ?? " ";
			const next = isDone(current) ? " " : "x";
			await this.writeCellStatus(view, table, cell, next, wrap, box);
		});
		box.addEventListener("contextmenu", (evt) =>
			this.showStatusMenu(evt, wrap.dataset.task ?? " ", (char) =>
				this.writeCellStatus(view, table, cell, char, wrap, box)
			)
		);
	}

	// --- Block-list tasks --------------------------------------------------

	private decorateListItem(li: HTMLLIElement, view: MarkdownView) {
		if (li.hasClass("tot-wired")) return;
		const input = li.querySelector<HTMLInputElement>(
			":scope > input.task-list-item-checkbox"
		);
		if (!input) return;
		li.addClass("tot-wired");

		// Defer rendering to the theme: keep Obsidian's native (themed) checkbox and
		// its native left-click toggle, and only add a right-click status menu for
		// custom statuses. We used to replace the checkbox with our own box, but on
		// foldable parent items the collapse affordance overlays that box and
		// swallows every pointer event, so parent tasks couldn't be clicked or
		// right-clicked at all. The native checkbox has no such problem.
		input.addEventListener("contextmenu", (evt) =>
			this.showStatusMenu(evt, li.getAttribute("data-task") || " ", (char) => {
				dlog("block right-click", { status: li.getAttribute("data-task"), char });
				this.writeBlockStatus(view, li, char);
			})
		);
	}

	// --- Shared helpers ----------------------------------------------------

	/** Paint a status box: empty for to-do, a check for done, else the raw char. */
	paintBox(box: HTMLElement, status: string) {
		box.dataset.task = status;
		box.toggleClass("is-filled", status !== " ");
		box.setText(status === " " ? "" : isDone(status) ? "✓" : status);
	}

	showStatusMenu(
		evt: MouseEvent,
		current: string,
		onPick: (char: string) => void
	) {
		evt.preventDefault();
		evt.stopPropagation();
		const menu = new Menu();
		for (const s of MENU_STATUSES) {
			menu.addItem((item) =>
				item
					.setTitle(`${s.label}  [${s.char}]`)
					.setChecked(current === s.char)
					.onClick(() => onPick(s.char))
			);
		}
		menu.showAtMouseEvent(evt);
	}

	/**
	 * Add a "Checkbox choices" submenu to the editor context menu (Live Preview /
	 * source), targeting the [status] marker nearest the click position.
	 */
	private addStatusSubmenu(menu: Menu, editor: Editor) {
		const cursor = editor.getCursor();
		const line = editor.getLine(cursor.line);
		// Only offer on task-ish lines (a block task, or a table row with a marker).
		if (!TASK_LINE_RE.test(line) && !line.includes("|")) return;
		const target = this.findMarkerNear(line, cursor.ch);
		if (!target) return;

		menu.addItem((item) => {
			item.setTitle("Checkbox choices");
			const sub = (
				item as unknown as { setSubmenu: () => Menu }
			).setSubmenu();
			for (const s of MENU_STATUSES) {
				sub.addItem((sub_item) =>
					sub_item
						.setTitle(`${s.label}  [${s.char}]`)
						.setChecked(target.char === s.char)
						.onClick(() =>
							editor.replaceRange(
								`[${s.char}]`,
								{ line: cursor.line, ch: target.start },
								{ line: cursor.line, ch: target.start + 3 }
							)
						)
				);
			}
		});
	}

	/** Find the [x]-style marker nearest column `ch` on a line. */
	private findMarkerNear(
		line: string,
		ch: number
	): { start: number; char: string } | null {
		const re = /\[(.)\]/g;
		let best: { start: number; char: string } | null = null;
		let bestDist = Infinity;
		let m: RegExpExecArray | null;
		while ((m = re.exec(line)) !== null) {
			const dist = Math.abs(ch - (m.index + 1));
			if (dist < bestDist) {
				bestDist = dist;
				best = { start: m.index, char: m[1] };
			}
		}
		return best;
	}

	// --- Write-back --------------------------------------------------------

	/**
	 * Rewrite a table cell's [status] marker in source. Maps DOM position:
	 * table index in the view -> block; DOM row r -> blockStart + (r ? r+1 : 0)
	 * (the +1 skips the :--- delimiter row); DOM column c -> c-th pipe field.
	 */
	private async writeCellStatus(
		view: MarkdownView,
		table: HTMLTableElement,
		cell: HTMLTableCellElement,
		newChar: string,
		wrap: HTMLElement,
		box: HTMLElement
	) {
		const file = view.file;
		if (!(file instanceof TFile)) return;

		const row = cell.parentElement as HTMLTableRowElement | null;
		if (!row) return;
		const rowIndex = row.rowIndex;
		const colIndex = cell.cellIndex;

		const domTables = Array.from(view.contentEl.querySelectorAll("table"));
		const tableIndex = domTables.indexOf(table);
		if (tableIndex < 0) return;

		const content = await this.app.vault.read(file);
		const lines = content.split("\n");
		const blocks = this.findTableBlocks(lines);
		if (tableIndex >= blocks.length) {
			new Notice("Table of Tasks: couldn't map the table to the source.");
			return;
		}
		const srcLineNo = blocks[tableIndex] + (rowIndex === 0 ? 0 : rowIndex + 1);
		if (srcLineNo < 0 || srcLineNo >= lines.length) return;

		const rewritten = this.rewriteCellStatus(lines[srcLineNo], colIndex, newChar);
		if (rewritten === null || rewritten === lines[srcLineNo]) return;

		wrap.dataset.task = newChar;
		wrap.toggleClass("is-struck", isStruck(newChar));
		this.paintBox(box, newChar);

		lines[srcLineNo] = rewritten;
		await this.app.vault.modify(file, lines.join("\n"));
	}

	/**
	 * Rewrite a block-list task's [status] marker. The k-th `li.task-list-item`
	 * in the view maps to the k-th block-task line in the source (table task
	 * lines start with "|" and don't match, so the two lists stay in sync).
	 */
	private async writeBlockStatus(
		view: MarkdownView,
		li: HTMLLIElement,
		newChar: string
	) {
		const file = view.file;
		if (!(file instanceof TFile)) return;

		const domTasks = Array.from(
			view.contentEl.querySelectorAll("li.task-list-item")
		);
		const index = domTasks.indexOf(li);
		if (index < 0) return;

		const content = await this.app.vault.read(file);
		const lines = content.split("\n");
		let seen = -1;
		let target = -1;
		for (let i = 0; i < lines.length; i++) {
			if (TASK_LINE_RE.test(lines[i])) {
				seen++;
				if (seen === index) {
					target = i;
					break;
				}
			}
		}
		dlog("writeBlock", {
			index,
			domCount: domTasks.length,
			target,
			targetLine: target >= 0 ? lines[target] : "(none)",
			newChar,
		});
		if (target < 0) {
			new Notice("Table of Tasks: couldn't map the task to the source.");
			return;
		}
		const rewritten = lines[target].replace(/\[.\]/, `[${newChar}]`);
		if (rewritten === lines[target]) return;

		// Rendering is the theme's job now; Obsidian re-renders on modify, so we
		// don't repaint anything ourselves.
		lines[target] = rewritten;
		await this.app.vault.modify(file, lines.join("\n"));
	}

	/** Return the starting line index (header row) of each Markdown table block. */
	private findTableBlocks(lines: string[]): number[] {
		const starts: number[] = [];
		const isDelim = (s: string) => /^[\s|:-]+$/.test(s) && s.includes("-");
		for (let i = 0; i + 1 < lines.length; i++) {
			if (lines[i].includes("|") && isDelim(lines[i + 1])) starts.push(i);
		}
		return starts;
	}

	private rewriteCellStatus(
		line: string,
		colIndex: number,
		newChar: string
	): string | null {
		const parts = line.split("|");
		const hasLeading = parts.length > 0 && parts[0].trim() === "";
		const target = (hasLeading ? 1 : 0) + colIndex;
		if (target < 0 || target >= parts.length) return null;
		const field = parts[target];
		const replaced = field.replace(/\[.\]/, `[${newChar}]`);
		if (replaced === field) return null;
		parts[target] = replaced;
		return parts.join("|");
	}
}

// --- Live Preview (CodeMirror 6) -------------------------------------------

/** A status box rendered in the Live Preview editor in place of a [status] marker. */
class StatusBoxWidget extends WidgetType {
	constructor(
		private status: string,
		private markerStart: number,
		private plugin: TableOfTasksPlugin
	) {
		super();
	}

	eq(other: StatusBoxWidget): boolean {
		return other.status === this.status && other.markerStart === this.markerStart;
	}

	toDOM(view: EditorView): HTMLElement {
		const box = createSpan({ cls: "tot-box tot-lp-box" });
		this.plugin.paintBox(box, this.status);
		box.addEventListener("mousedown", (evt) => evt.preventDefault());
		box.addEventListener("click", (evt) => {
			evt.preventDefault();
			this.setStatus(view, isDone(this.status) ? " " : "x");
		});
		box.addEventListener("contextmenu", (evt) =>
			this.plugin.showStatusMenu(evt, this.status, (char) =>
				this.setStatus(view, char)
			)
		);
		return box;
	}

	/** Rewrite the 3-char [status] marker via an editor transaction. */
	private setStatus(view: EditorView, char: string) {
		view.dispatch({
			changes: {
				from: this.markerStart,
				to: this.markerStart + 3,
				insert: `[${char}]`,
			},
		});
	}

	/** Let the widget handle its own click/contextmenu instead of the editor. */
	ignoreEvent(): boolean {
		return true;
	}
}

/**
 * A CodeMirror ViewPlugin that swaps each block-list task's [status] marker for
 * our status box while in Live Preview. The line under the cursor/selection is
 * left as raw text so it stays editable (matching Obsidian's own behaviour).
 */
function livePreviewBoxes(plugin: TableOfTasksPlugin) {
	return ViewPlugin.fromClass(
		class {
			decorations: DecorationSet;

			constructor(view: EditorView) {
				this.decorations = this.build(view);
			}

			update(u: ViewUpdate) {
				if (u.docChanged || u.viewportChanged || u.selectionSet) {
					this.decorations = this.build(u.view);
				}
			}

			build(view: EditorView): DecorationSet {
				const builder = new RangeSetBuilder<Decoration>();
				// Only in Live Preview (not source mode), and only if enabled.
				if (!view.state.field(editorLivePreviewField)) return builder.finish();
				if (!plugin.settings.styleBlockTasks) return builder.finish();

				const doc = view.state.doc;
				const sel = view.state.selection.main;
				for (const { from, to } of view.visibleRanges) {
					let line = doc.lineAt(from);
					while (line.from <= to) {
						const m = TASK_PREFIX_RE.exec(line.text);
						if (m) {
							// Leave the line the cursor/selection touches as raw text.
							const active = sel.from <= line.to && sel.to >= line.from;
							if (!active) {
								const status = m[2];
								const markerStart = line.from + m[1].length;
								builder.add(
									markerStart,
									markerStart + 3,
									Decoration.replace({
										widget: new StatusBoxWidget(status, markerStart, plugin),
									})
								);
								// Strike the label text for finished/abandoned statuses.
								if (isStruck(status) && markerStart + 3 < line.to) {
									builder.add(
										markerStart + 3,
										line.to,
										Decoration.mark({ class: "tot-lp-struck" })
									);
								}
							}
						}
						if (line.to + 1 > doc.length) break;
						line = doc.lineAt(line.to + 1);
					}
				}
				return builder.finish();
			}
		},
		{ decorations: (v) => v.decorations }
	);
}

class TableOfTasksSettingTab extends PluginSettingTab {
	plugin: TableOfTasksPlugin;

	constructor(app: App, plugin: TableOfTasksPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display() {
		const { containerEl } = this;
		containerEl.empty();
		new Setting(containerEl)
			.setName("Style block-list tasks too")
			.setDesc(
				"Apply the same status boxes to normal task lists outside tables, not just inside them. Turn off to leave block tasks to your theme."
			)
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.styleBlockTasks)
					.onChange(async (value) => {
						this.plugin.settings.styleBlockTasks = value;
						await this.plugin.saveSettings();
					})
			);
	}
}
