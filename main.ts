// SPDX-License-Identifier: GPL-2.0-only

import {
	App,
	Editor,
	MarkdownRenderChild,
	MarkdownView,
	Menu,
	Notice,
	Plugin,
	PluginSettingTab,
	Setting,
	TFile,
	type MarkdownFileInfo,
	type MarkdownPostProcessorContext,
} from "obsidian";

import {
	cellMarker,
	editorMarker,
	findTables,
	listMarker,
	normalized,
	renderedMarker,
	replaceStatus,
	type Marker,
} from "./markdown";

const MENU_STATUSES = [
	{ char: " ", label: "To do" },
	{ char: "x", label: "Done" },
	{ char: "/", label: "In progress" },
	{ char: "-", label: "Cancelled" },
	{ char: ">", label: "Forwarded" },
	{ char: "?", label: "Question" },
	{ char: "!", label: "Important" },
];

const isDone = (status: string) => status.toLowerCase() === "x";
const themeStatus = (status: string) =>
	isDone(status) ? "x" : MENU_STATUSES.some(({ char }) => char === status) ? status : "!";
const FOREIGN_MARKDOWN = ".internal-embed, .markdown-embed, .markdown-source-view";

interface FlexibleTasksSettings {
	styleBlockTasks: boolean;
}

const DEFAULT_SETTINGS: FlexibleTasksSettings = { styleBlockTasks: true };

interface Target {
	line: number;
	cell?: number;
	identity: string;
}

interface Task {
	target: Target;
	input: HTMLInputElement;
}

interface PendingWrites {
	tail: Promise<void>;
	count: number;
	current?: string;
	known: Set<string>;
}

const STALE_SOURCE = new Error("Stale Markdown source");

function getMarker(line: string | undefined, target: Target): Marker | null {
	if (line === undefined) return null;
	return target.cell === undefined ? listMarker(line) : cellMarker(line, target.cell);
}

function statuses(menu: Menu, current: string, select: (char: string) => void) {
	for (const { char, label } of MENU_STATUSES) {
		menu.addItem((item) => item
			.setTitle(`${label}  [${char}]`)
			.setChecked(char === current || (char === "x" && isDone(current)))
			.onClick(() => select(char)));
	}
}

export default class FlexibleTasksPlugin extends Plugin {
	settings: FlexibleTasksSettings = DEFAULT_SETTINGS;
	private active = false;
	private loadId = 0;
	private readonly rendered = new Set<MarkdownRenderChild>();
	private readonly wiredBlocks = new WeakSet<HTMLInputElement>();
	private readonly writes = new WeakMap<TFile, PendingWrites>();
	private source = { text: "", normalized: "", lines: [""] };

	async onload() {
		const loadId = ++this.loadId;
		const saved = (await this.loadData()) as Partial<FlexibleTasksSettings> | null;
		if (loadId !== this.loadId) return;
		this.settings = { ...DEFAULT_SETTINGS, ...(saved ?? {}) };
		this.active = true;
		this.addSettingTab(new FlexibleTasksSettingTab(this.app, this));
		this.registerMarkdownPostProcessor((el, ctx) => this.processSection(el, ctx));
		this.registerEvent(this.app.workspace.on("editor-menu", (menu, editor, info) =>
			this.addStatusSubmenu(menu, editor, info)));
		// A preview can already be built when the plugin is enabled. Later renders
		// go directly through the registered processor, including restored notes.
		this.refreshPreviews();
	}

	onunload() {
		this.loadId++;
		this.active = false;
		for (const section of this.rendered) section.unload();
	}

	async saveSettings() {
		await this.saveData(this.settings);
		this.refreshPreviews();
	}

	private refreshPreviews() {
		if (!this.active) return;
		for (const { view } of this.app.workspace.getLeavesOfType("markdown")) {
			if (view instanceof MarkdownView && view.getMode() === "preview" &&
				view.previewMode.containerEl.querySelector("td, li.task-list-item")) {
				view.previewMode.rerender(true);
			}
		}
	}

	private getSource(text: string) {
		if (text !== this.source.text) {
			const source = normalized(text);
			this.source = { text, normalized: source, lines: source.split("\n") };
		}
		return this.source;
	}

	private processSection(el: HTMLElement, ctx: MarkdownPostProcessorContext) {
		if (!this.active || el.closest(FOREIGN_MARKDOWN)) return;
		const tables = Array.from(el.querySelectorAll<HTMLTableElement>("table")).filter((table) =>
			!table.parentElement?.closest(`table, ${FOREIGN_MARKDOWN}`));
		const blocks = this.settings.styleBlockTasks
			? el.querySelectorAll<HTMLLIElement>("li.task-list-item[data-line]:not(.tot-cell-task)")
			: [];
		if (!tables.length && !blocks.length) return;
		const info = ctx.getSectionInfo(el);
		if (!info || !ctx.sourcePath) return;
		const file = this.app.vault.getAbstractFileByPath(ctx.sourcePath);
		if (!(file instanceof TFile)) return;
		const { lines } = this.getSource(info.text);
		if (info.lineStart < 0 || info.lineEnd >= lines.length) return;

		const cleanups: Array<() => void> = [];
		const tasks = new WeakMap<Element, Task>();
		let anchor: HTMLInputElement | undefined;
		const bind = (element: Element, task: Task) => {
			tasks.set(element, task);
			anchor ??= task.input;
		};

		// Section positions come from the same render pass as the HTML. A match
		// also needs the table geometry, keeping generated HTML in other sections
		// from influencing this section's source positions.
		const sourceTables = tables.length ? findTables(lines, info.lineStart, info.lineEnd) : [];
		if (sourceTables.length === tables.length) {
			tables.forEach((table, index) => {
				const { header, end, columns } = sourceTables[index];
				if (table.rows.length !== end - header || table.tHead?.rows[0]?.cells.length !== columns) return;
				for (const row of Array.from(table.rows).slice(1)) {
					const line = header + row.rowIndex + 1;
					for (const cell of Array.from(row.cells)) {
						const first = cell.firstChild;
						if (first?.nodeType !== 3) continue;
						const prefix = renderedMarker(first.textContent ?? "");
						if (!prefix) continue;
						const marker = cellMarker(lines[line], cell.cellIndex);
						if (!marker || prefix.status !== marker.status) continue;
						const target = { line: line - info.lineStart, cell: cell.cellIndex, identity: marker.identity };
						const { wrap, task, cleanup } = decorateCell(cell, first as Text, prefix.prefix, marker.status, target);
						bind(wrap, task);
						tasks.set(task.input, task);
						cleanups.push(cleanup);
					}
				}
			});
		}

		for (const li of Array.from(blocks)) {
			if (li.closest(`table, ${FOREIGN_MARKDOWN}`)) continue;
			const input = li.querySelector<HTMLInputElement>(
				":scope > input.task-list-item-checkbox, :scope > p > input.task-list-item-checkbox");
			const relative = li.dataset.line ?? "";
			if (!input || this.wiredBlocks.has(input) || !/^\d+$/.test(relative) || input.dataset.line !== relative) continue;
			const line = info.lineStart + Number(relative);
			if (line > info.lineEnd) continue;
			const marker = listMarker(lines[line]);
			if (!marker || marker.status !== (li.dataset.task || " ")) continue;
			this.wiredBlocks.add(input);
			li.classList.add("tot-block-task");
			bind(input, { input, target: { line: Number(relative), identity: marker.identity } });
			const attributes = [li, input].map((node) => node.getAttribute("data-task"));
			const mapped = themeStatus(marker.status);
			if (mapped === "!" && marker.status !== mapped) {
				li.dataset.task = input.dataset.task = mapped;
			}
			cleanups.push(() => {
				this.wiredBlocks.delete(input);
				li.classList.remove("tot-block-task");
				if (mapped !== "!" || marker.status === mapped) return;
				[li, input].forEach((node, index) => {
					if (node.dataset.task !== mapped) return;
					const original = attributes[index];
					if (original === null) node.removeAttribute("data-task");
					else node.dataset.task = original;
				});
			});
		}
		if (!anchor) return;

		const capture = (task: Task) => {
			if (!this.active || !el.isConnected || !el.contains(task.input)) return null;
			if (task.target.cell === undefined && !this.settings.styleBlockTasks) return null;
			const view = this.app.workspace.getLeavesOfType("markdown")
				.map(({ view }) => view)
				.find((view): view is MarkdownView => view instanceof MarkdownView &&
					view.getMode() === "preview" && view.file === file &&
					view.previewMode.containerEl.contains(el));
			if (!view) return null;
			const current = ctx.getSectionInfo(el);
			if (!current) return null;
			const source = this.getSource(current.text);
			const line = current.lineStart + task.target.line;
			const marker = getMarker(source.lines[line], task.target);
			if (line > current.lineEnd || marker?.identity !== task.target.identity) {
				new Notice("Flexible Tasks: the task changed. Try again after the note updates.");
				return null;
			}
			return { file, line, marker, snapshot: source.normalized };
		};

		const taskAt = (evt: MouseEvent, selector: string) => {
			const origin = evt.target as Element | null;
			if (!origin?.closest || origin.closest("a, button, [contenteditable=true]")) return undefined;
			const node = origin.closest(selector);
			return node ? tasks.get(node) : undefined;
		};
		const click = (evt: MouseEvent) => {
			const task = taskAt(evt, ".tot-cell-task");
			if (!task || evt.defaultPrevented) return;
			evt.preventDefault();
			evt.stopPropagation();
			const request = capture(task);
			if (request) this.writeStatus(request, task);
		};
		const context = (evt: MouseEvent) => {
			const task = taskAt(evt, ".tot-cell-task, input.task-list-item-checkbox");
			if (!task || evt.defaultPrevented) return;
			const request = capture(task);
			if (!request) return;
			evt.preventDefault();
			evt.stopPropagation();
			const menu = new Menu();
			statuses(menu, request.marker.status, (char) => {
				const current = capture(task);
				if (current?.file === request.file && current.snapshot === request.snapshot) {
					this.writeStatus(request, task, char);
				} else if (current) {
					new Notice("Flexible Tasks: the task changed while the menu was open.");
				}
			});
			menu.showAtMouseEvent(evt);
		};

		// Obsidian keeps offscreen sections alive and unloads children when their
		// rendered DOM is replaced. Anchor to the input, since the wrapper section
		// itself may be reused on a full rerender.
		const child = new MarkdownRenderChild(anchor);
		el.addEventListener("click", click);
		el.addEventListener("contextmenu", context);
		this.rendered.add(child);
		child.register(() => {
			el.removeEventListener("click", click);
			el.removeEventListener("contextmenu", context);
			for (const cleanup of cleanups) cleanup();
			this.rendered.delete(child);
		});
		ctx.addChild(child);
	}

	private writeStatus(
		request: { file: TFile; line: number; snapshot: string },
		task: Task,
		selected?: string
	) {
		const { file, line, snapshot } = request;
		let pending = this.writes.get(file);
		if (!pending) {
			pending = { tail: Promise.resolve(), count: 0, known: new Set() };
			this.writes.set(file, pending);
		}
		const queue = pending;
		const loadId = this.loadId;
		const active = () => this.active && this.loadId === loadId;
		queue.count++;
		queue.tail = queue.tail.then(async () => {
			if (!active()) return;
			let before: string | undefined;
			try {
				// Obsidian may reuse existing DOM for the original Markdown.
				// Write the source and let the renderer display the new revision.
				const written = await this.app.vault.process(file, (text) => {
					const source = this.getSource(text);
					if (!active() || this.app.vault.getAbstractFileByPath(file.path) !== file ||
						(source.normalized !== snapshot &&
							(source.normalized !== queue.current || !queue.known.has(snapshot)))) {
						throw STALE_SOURCE;
					}
					// Saving through the vault must never overwrite a dirty editor
					// in a split pane, including edits that have yet to reach disk.
					for (const { view } of this.app.workspace.getLeavesOfType("markdown")) {
						if (view instanceof MarkdownView && view.file === file && view.getMode() === "source" &&
							normalized(view.getViewData()) !== source.normalized) throw STALE_SOURCE;
					}
					const marker = getMarker(source.lines[line], task.target);
					if (marker?.identity !== task.target.identity) throw STALE_SOURCE;
					before = source.normalized;
					const status = selected ?? (isDone(marker.status) ? " " : "x");
					return replaceStatus(text, line, marker, status);
				});
				// An external edit starts a new lineage. Positions captured before it
				// cannot be reused, even if the text of a different task matches.
				if (before !== queue.current) queue.known.clear();
				queue.current = normalized(written);
				queue.known.add(snapshot);
				if (before !== undefined) queue.known.add(before);
			} catch (error) {
				if (active()) {
					new Notice(error === STALE_SOURCE
						? "Flexible Tasks: the note changed. Try again after the note updates."
						: "Flexible Tasks: the task could not be saved.");
				}
			}
		}).finally(() => {
			if (--queue.count === 0) {
				// Keep a bounded bridge while Reading view catches up with the last write.
				queue.known = queue.known.has(snapshot) ? new Set([snapshot]) : new Set();
			}
		});
	}

	private addStatusSubmenu(menu: Menu, editor: Editor, info: MarkdownFileInfo) {
		const file = info.file;
		if (!file) return;
		const cursor = editor.getCursor();
		const line = editor.getLine(cursor.line);
		if (!line.includes("|") && !listMarker(line)) return;
		const source = editor.getValue();
		const target = editorMarker(source, cursor.line, cursor.ch);
		if (!target) return;

		const select = (char: string) => {
			if (!this.active || info.file !== file || editor.getValue() !== source ||
				(info instanceof MarkdownView && info.getMode() !== "source")) {
				new Notice("Flexible Tasks: the task changed while the menu was open.");
				return;
			}
			if (target.status === char) return;
			editor.replaceRange(char, { line: cursor.line, ch: target.column },
				{ line: cursor.line, ch: target.column + target.raw.length });
		};
		menu.addItem((item) => {
			item.setTitle("Checkbox choices");
			const submenu = (item as typeof item & { setSubmenu?: () => Menu }).setSubmenu?.();
			if (submenu) statuses(submenu, target.status, select);
			else item.onClick((evt) => {
				const choices = new Menu();
				statuses(choices, target.status, select);
				if ("clientX" in evt) choices.showAtMouseEvent(evt);
				else choices.showAtPosition({ x: 0, y: 0 });
			});
		});
	}
}

function decorateCell(cell: HTMLTableCellElement, first: Text, prefix: string, initial: string, target: Target) {
	const original = first.data;
	first.deleteData(0, prefix.length);
	const content = Array.from(cell.childNodes);
	const list = cell.createEl("ul", { cls: "contains-task-list tot-cell-list" });
	const wrap = list.createEl("li", { cls: "task-list-item tot-cell-task" });
	const input = wrap.createEl("input", { cls: "task-list-item-checkbox", attr: { type: "checkbox" } });
	const label = wrap.createSpan({ cls: "tot-cell-label" });
	label.append(...content);
	const heading = cell.closest("table")?.tHead?.rows[0]?.cells[cell.cellIndex]?.textContent?.trim();
	const row = (cell.parentElement as HTMLTableRowElement).rowIndex;
	input.setAttribute("aria-label", label.textContent?.trim() || `${heading || "Table task"}, row ${row}`);
	const mapped = themeStatus(initial);
	input.checked = initial !== " ";
	wrap.classList.toggle("is-checked", input.checked);
	wrap.dataset.task = input.checked ? mapped : "";
	if (input.checked) input.dataset.task = mapped;
	const name = MENU_STATUSES.find(({ char }) => char === initial)?.label ??
		(isDone(initial) ? "Done" : `Custom "${initial}"`);
	wrap.title = `Task status: ${name}`;
	return {
		wrap,
		task: { target, input },
		cleanup: () => {
			if (list.parentElement !== cell) return;
			first.data = original;
			list.replaceWith(...Array.from(label.childNodes));
		},
	};
}
class FlexibleTasksSettingTab extends PluginSettingTab {
	plugin: FlexibleTasksPlugin;

	constructor(app: App, plugin: FlexibleTasksPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	// Declarative settings (Obsidian 1.13+): the settings show up in Obsidian's
	// settings search. On older versions this is ignored and display() runs.
	getSettingDefinitions() {
		return [
			{
				name: "Style block-list tasks too",
				desc: "Also add the right-click status menu to ordinary (non-table) list tasks in Reading view.",
				control: {
					type: "toggle" as const,
					key: "styleBlockTasks",
					defaultValue: DEFAULT_SETTINGS.styleBlockTasks,
				},
			},
		];
	}

	getControlValue(key: string): unknown {
		if (key === "styleBlockTasks") return this.plugin.settings.styleBlockTasks;
		return undefined;
	}

	async setControlValue(key: string, value: unknown): Promise<void> {
		if (key === "styleBlockTasks") {
			this.plugin.settings.styleBlockTasks = Boolean(value);
			await this.plugin.saveSettings();
		}
	}

	// Fallback for Obsidian < 1.13, where the declarative API above is unavailable.
	display() {
		const { containerEl } = this;
		containerEl.empty();
		new Setting(containerEl)
			.setName("Style block-list tasks too")
			.setDesc(
				"Also add the right-click status menu to ordinary (non-table) list tasks in Reading view."
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
