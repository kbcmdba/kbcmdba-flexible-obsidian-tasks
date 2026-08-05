// SPDX-License-Identifier: GPL-2.0-only

import {
	Plugin,
	MarkdownPostProcessorContext,
	Menu,
	Notice,
	TFile,
} from "obsidian";

/**
 * Matches a table cell whose text is a task: a list marker (-, *, +), then the
 * [x] status box with ANY single character inside, then an optional label.
 *
 * The status character set is deliberately OPEN (not a fixed whitelist) so that
 * theme-defined statuses like [/], [-], [>], [?] all render and round-trip.
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

export default class TableOfTasksPlugin extends Plugin {
	async onload() {
		this.registerMarkdownPostProcessor((el, ctx) =>
			this.renderTableTasks(el, ctx)
		);
	}

	/** Reading-view post-processor: turn task-shaped cell text into checkboxes. */
	private renderTableTasks(el: HTMLElement, ctx: MarkdownPostProcessorContext) {
		const tables = Array.from(el.querySelectorAll("table"));
		for (const table of tables) {
			const cells = Array.from(
				table.querySelectorAll<HTMLTableCellElement>("td, th")
			);
			for (const cell of cells) {
				const match = (cell.textContent ?? "").match(TASK_CELL_RE);
				if (!match) continue;
				const status = match[1];
				const label = (match[2] ?? "").trim();
				this.decorateCell(cell, status, label, ctx, el, table);
			}
		}
	}

	private decorateCell(
		cell: HTMLTableCellElement,
		status: string,
		label: string,
		ctx: MarkdownPostProcessorContext,
		sectionEl: HTMLElement,
		table: HTMLTableElement
	) {
		cell.empty();
		const wrap = cell.createDiv({ cls: "tot-task task-list-item" });
		wrap.dataset.task = status;
		if (isDone(status)) wrap.addClass("is-done");

		const box = wrap.createEl("input", {
			cls: "task-list-item-checkbox tot-checkbox",
			attr: { type: "checkbox" },
		});
		box.checked = isDone(status);
		box.dataset.task = status;

		wrap.createSpan({ cls: "tot-task-label", text: label });

		// Model A: left-click toggles done <-> to-do.
		box.addEventListener("click", async (evt) => {
			evt.preventDefault();
			const current = wrap.dataset.task ?? " ";
			const next = isDone(current) ? " " : "x";
			await this.writeStatus(ctx, sectionEl, table, cell, next, wrap, box);
		});

		// Right-click: set any status.
		wrap.addEventListener("contextmenu", (evt) => {
			evt.preventDefault();
			const menu = new Menu();
			for (const s of MENU_STATUSES) {
				menu.addItem((item) =>
					item
						.setTitle(`${s.label}  [${s.char === " " ? " " : s.char}]`)
						.setChecked((wrap.dataset.task ?? " ") === s.char)
						.onClick(async () => {
							await this.writeStatus(
								ctx,
								sectionEl,
								table,
								cell,
								s.char,
								wrap,
								box
							);
						})
				);
			}
			menu.showAtMouseEvent(evt);
		});
	}

	/**
	 * Locate this cell in the source Markdown by its table position and rewrite
	 * the [status] marker. The mapping is deterministic:
	 *   - table source line 0 = header row
	 *   - table source line 1 = delimiter (:---) row, which has NO rendered <tr>
	 *   - so a DOM row at rowIndex r maps to source line
	 *       lineStart + (r === 0 ? 0 : r + 1)
	 *   - column c maps to the c-th pipe-delimited field
	 *
	 * Known limitations (MVP): assumes one table per rendered section, standard
	 * leading/trailing pipes, and no escaped \| inside cells.
	 */
	private async writeStatus(
		ctx: MarkdownPostProcessorContext,
		sectionEl: HTMLElement,
		table: HTMLTableElement,
		cell: HTMLTableCellElement,
		newChar: string,
		wrap: HTMLElement,
		box: HTMLInputElement
	) {
		const info = ctx.getSectionInfo(table) ?? ctx.getSectionInfo(sectionEl);
		if (!info) {
			new Notice("Table of Tasks: couldn't locate the table in the source.");
			return;
		}

		const file = this.app.vault.getAbstractFileByPath(ctx.sourcePath);
		if (!(file instanceof TFile)) return;

		const row = cell.parentElement as HTMLTableRowElement | null;
		if (!row) return;
		const rowIndex = row.rowIndex; // continuous across thead + tbody
		const colIndex = cell.cellIndex; // within the row

		const srcLineNo = info.lineStart + (rowIndex === 0 ? 0 : rowIndex + 1);

		const content = await this.app.vault.read(file);
		const lines = content.split("\n");
		if (srcLineNo < 0 || srcLineNo >= lines.length) return;

		const rewritten = this.rewriteCellStatus(lines[srcLineNo], colIndex, newChar);
		if (rewritten === null) {
			new Notice("Table of Tasks: couldn't find the task cell to update.");
			return;
		}
		if (rewritten === lines[srcLineNo]) return; // nothing changed

		// Optimistic UI update; the vault change re-renders and confirms.
		wrap.dataset.task = newChar;
		box.dataset.task = newChar;
		box.checked = isDone(newChar);
		wrap.toggleClass("is-done", isDone(newChar));

		lines[srcLineNo] = rewritten;
		await this.app.vault.modify(file, lines.join("\n"));
	}

	/**
	 * Replace the [status] marker inside the colIndex-th cell of a Markdown
	 * table row. Returns the rewritten line, or null if the cell or marker
	 * wasn't found.
	 */
	private rewriteCellStatus(
		line: string,
		colIndex: number,
		newChar: string
	): string | null {
		const parts = line.split("|");
		// With leading/trailing pipes, parts looks like ["", " a ", " b ", ""].
		const hasLeading = parts.length > 0 && parts[0].trim() === "";
		const target = (hasLeading ? 1 : 0) + colIndex;
		if (target < 0 || target >= parts.length) return null;

		const field = parts[target];
		const replaced = field.replace(/\[.\]/, `[${newChar}]`);
		if (replaced === field) return null; // no [status] marker in this cell
		parts[target] = replaced;
		return parts.join("|");
	}
}
