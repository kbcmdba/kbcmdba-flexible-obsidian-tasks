// SPDX-License-Identifier: GPL-2.0-only

import { Plugin, Menu, Notice, TFile, MarkdownView } from "obsidian";

/**
 * Matches a table cell whose text is a task: a list marker (-, *, +), then the
 * [x] status box with ANY single character inside, then an optional label.
 * The status character set is deliberately OPEN so custom statuses ([/], [-],
 * [>], [?], ...) all render and round-trip.
 */
const TASK_CELL_RE = /^\s*[-*+]\s+\[(.)\]\s*(.*)$/;

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

export default class TableOfTasksPlugin extends Plugin {
	private scanQueued = false;

	async onload() {
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
		this.app.workspace.onLayoutReady(() => this.queueScan());
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

	/** Scan every open markdown view's rendered content for table task cells. */
	private scanReadingViews() {
		for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
			const view = leaf.view;
			if (!(view instanceof MarkdownView)) continue;
			// Headers and already-decorated cells no longer contain "- [ ] ..."
			// text, so they simply won't match - no extra guard needed.
			const cells =
				view.contentEl.querySelectorAll<HTMLTableCellElement>("td, th");
			cells.forEach((cell) => {
				const match = (cell.textContent ?? "").match(TASK_CELL_RE);
				if (!match) return;
				const table = cell.closest("table");
				if (!table) return;
				this.decorateCell(cell, match[1], (match[2] ?? "").trim(), view, table);
			});
		}
	}

	private decorateCell(
		cell: HTMLTableCellElement,
		status: string,
		label: string,
		view: MarkdownView,
		table: HTMLTableElement
	) {
		cell.empty();
		const wrap = cell.createDiv({ cls: "tot-task task-list-item" });
		wrap.dataset.task = status;
		if (isStruck(status)) wrap.addClass("is-struck");

		const box = wrap.createSpan({ cls: "tot-box" });
		this.paintBox(box, status);

		wrap.createSpan({ cls: "tot-task-label", text: label });

		// Model A: left-click toggles done <-> to-do.
		box.addEventListener("click", async (evt) => {
			evt.preventDefault();
			const current = wrap.dataset.task ?? " ";
			const next = isDone(current) ? " " : "x";
			await this.writeStatus(view, table, cell, next, wrap, box);
		});

		// Right-click: set any status.
		wrap.addEventListener("contextmenu", (evt) => {
			evt.preventDefault();
			evt.stopPropagation();
			const menu = new Menu();
			for (const s of MENU_STATUSES) {
				menu.addItem((item) =>
					item
						.setTitle(`${s.label}  [${s.char}]`)
						.setChecked((wrap.dataset.task ?? " ") === s.char)
						.onClick(async () => {
							await this.writeStatus(view, table, cell, s.char, wrap, box);
						})
				);
			}
			menu.showAtMouseEvent(evt);
		});
	}

	/** Paint a status box: empty for to-do, a check for done, else the raw char. */
	private paintBox(box: HTMLElement, status: string) {
		box.dataset.task = status;
		// Highlight the box for any chosen status (anything other than to-do).
		box.toggleClass("is-filled", status !== " ");
		box.setText(status === " " ? "" : isDone(status) ? "✓" : status);
	}

	/**
	 * Rewrite the [status] marker for this cell in the source file. Maps the DOM
	 * table position to the source Markdown:
	 *   - identify which table by the DOM table's index within the view
	 *   - within that block, DOM row r -> source line
	 *       blockStart + (r === 0 ? 0 : r + 1)   (the +1 skips the :--- delimiter)
	 *   - DOM column c -> the c-th pipe-delimited field
	 */
	private async writeStatus(
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

		// Optimistic UI update; the vault change re-renders and confirms.
		wrap.dataset.task = newChar;
		wrap.toggleClass("is-struck", isStruck(newChar));
		this.paintBox(box, newChar);

		lines[srcLineNo] = rewritten;
		await this.app.vault.modify(file, lines.join("\n"));
	}

	/** Return the starting line index (header row) of each Markdown table block. */
	private findTableBlocks(lines: string[]): number[] {
		const starts: number[] = [];
		// A delimiter row is only pipes/spaces/colons/dashes and has at least one dash.
		const isDelim = (s: string) => /^[\s|:-]+$/.test(s) && s.includes("-");
		for (let i = 0; i + 1 < lines.length; i++) {
			if (lines[i].includes("|") && isDelim(lines[i + 1])) starts.push(i);
		}
		return starts;
	}

	/**
	 * Replace the [status] marker inside the colIndex-th cell of a table row.
	 * Returns the rewritten line, or null if the cell/marker wasn't found.
	 */
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
