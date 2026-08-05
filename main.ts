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
} from "obsidian";

/** A table cell whose text is a task: list marker, [status] box, optional label. */
const TASK_CELL_RE = /^\s*[-*+]\s+\[(.)\]\s*(.*)$/;
/** A block-list task line in the source (any indentation). */
const TASK_LINE_RE = /^\s*[-*+]\s+\[.\]/;

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
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings() {
		await this.saveData(this.settings);
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
		if (li.hasClass("tot-decorated")) return;
		const input = li.querySelector<HTMLInputElement>(
			":scope > input.task-list-item-checkbox"
		);
		if (!input) return;
		const raw = li.getAttribute("data-task");
		const status = raw && raw.length ? raw : " ";
		li.addClass("tot-decorated");

		// Replace the native checkbox with our status box, preserving everything
		// else in the item (including any nested sub-tasks).
		const box = createSpan({ cls: "tot-box tot-block-box" });
		input.replaceWith(box);
		this.paintBox(box, status);

		// Wrap the item's own label text (not nested sub-lists) so we can strike
		// just this task without striking its children.
		const label = createSpan({ cls: "tot-task-label tot-block-label" });
		const move: ChildNode[] = [];
		li.childNodes.forEach((n) => {
			if (n === box) return;
			if (n instanceof HTMLElement && (n.tagName === "UL" || n.tagName === "OL"))
				return;
			move.push(n);
		});
		move.forEach((n) => label.appendChild(n));
		box.after(label);
		if (isStruck(status)) label.addClass("is-struck");

		box.addEventListener("click", async (evt) => {
			evt.preventDefault();
			const current = box.dataset.task ?? " ";
			const next = isDone(current) ? " " : "x";
			await this.writeBlockStatus(view, li, next, box, label);
		});
		box.addEventListener("contextmenu", (evt) =>
			this.showStatusMenu(evt, box.dataset.task ?? " ", (char) =>
				this.writeBlockStatus(view, li, char, box, label)
			)
		);
	}

	// --- Shared helpers ----------------------------------------------------

	/** Paint a status box: empty for to-do, a check for done, else the raw char. */
	private paintBox(box: HTMLElement, status: string) {
		box.dataset.task = status;
		box.toggleClass("is-filled", status !== " ");
		box.setText(status === " " ? "" : isDone(status) ? "✓" : status);
	}

	private showStatusMenu(
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
		newChar: string,
		box: HTMLElement,
		label: HTMLElement
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
		if (target < 0) {
			new Notice("Table of Tasks: couldn't map the task to the source.");
			return;
		}
		const rewritten = lines[target].replace(/\[.\]/, `[${newChar}]`);
		if (rewritten === lines[target]) return;

		box.dataset.task = newChar;
		this.paintBox(box, newChar);
		label.toggleClass("is-struck", isStruck(newChar));

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
