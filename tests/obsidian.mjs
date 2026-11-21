// SPDX-License-Identifier: GPL-2.0-only

import assert from "node:assert/strict";
import { readFileSync, realpathSync } from "node:fs";
import { dirname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { dashboardFixture, issueFixture } from "./fixtures.mjs";

const [port, directory, phase = "exercise"] = process.argv.slice(2);
if (!/^\d+$/.test(port ?? "") || !directory || !["startup", "exercise", "restored"].includes(phase)) {
	throw new Error("Usage: node tests/obsidian.mjs PORT VAULT startup|exercise|restored");
}
const vault = realpathSync(directory);
const testRoot = realpathSync(join(dirname(dirname(fileURLToPath(import.meta.url))), "test-vault"));
assert.ok(vault.startsWith(testRoot + sep), "Use a generated vault inside the repository's test-vault directory");

const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const target = targets.find((target) => target.type === "page" && target.url === "app://obsidian.md/index.html");
assert.ok(target?.webSocketDebuggerUrl, "The isolated Obsidian window is unavailable");
const socket = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((ready, fail) => {
	socket.addEventListener("open", ready, { once: true });
	socket.addEventListener("error", fail, { once: true });
});
let sequence = 0;

async function run(label, scenario, ...args) {
	const result = await evaluate(`(${inObsidian})(${JSON.stringify(vault)}, ${scenario}, ${JSON.stringify(args)})`);
	process.stdout.write(`PASS ${label}${result === undefined ? "" : " " + JSON.stringify(result)}\n`);
	return result;
}

function evaluate(expression) {
	return new Promise((accept, reject) => {
		const id = ++sequence;
		const receive = ({ data }) => {
			const reply = JSON.parse(data);
			if (reply.id !== id) return;
			socket.removeEventListener("message", receive);
			const { result, exceptionDetails } = reply.result ?? {};
			if (reply.error || exceptionDetails) {
				reject(new Error(exceptionDetails?.exception?.description ?? JSON.stringify(reply.error)));
			} else {
				accept(result?.value);
			}
		};
		socket.addEventListener("message", receive);
		socket.send(JSON.stringify({ id, method: "Runtime.evaluate", params: {
			expression, awaitPromise: true, returnByValue: true,
		} }));
	});
}

async function inObsidian(path, scenario, args) {
	const app = globalThis.app;
	if (!app || app.vault.adapter.getBasePath() !== path) throw new Error("Unexpected Obsidian vault");
	const check = (actual, expected, message) => {
		if (actual !== expected) throw new Error(`${message} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);
	};
	const wait = async (condition, label) => {
		const deadline = performance.now() + 7000;
		while (performance.now() < deadline) {
			const value = await condition();
			if (value) return value;
			await new Promise((resolve) => setTimeout(resolve, 20));
		}
		throw new Error(`Timed out: ${label}`);
	};
	const leaf = app.workspace.getLeavesOfType("markdown")[0];
	const reading = (pane = leaf) => pane.view.previewMode.containerEl;
	const cells = (pane = leaf) => [...reading(pane).querySelectorAll("table .tot-cell-task > input")];
	const file = (name) => app.vault.getAbstractFileByPath(name);
	const disk = (name) => app.vault.read(file(name));
	const open = async (name, mode = "preview", source = false, pane = leaf) => {
		await pane.openFile(file(name), { state: { mode, source } });
		await wait(() => pane.view.file?.path === name && pane.view.getMode() === mode, `open ${name} in ${mode}`);
	};
	const mode = async (mode, source = false) => {
		const state = leaf.getViewState();
		await leaf.setViewState({ ...state, state: { ...state.state, mode, source } });
		await wait(() => leaf.view.getMode() === mode, `switch to ${mode}`);
	};
	const context = (el) => {
		const bounds = el.getBoundingClientRect();
		el.dispatchEvent(new MouseEvent("contextmenu", {
			bubbles: true, cancelable: true, view: window, button: 2, clientX: bounds.x, clientY: bounds.y,
		}));
	};
	const pick = async (text) => {
		const item = await wait(() => [...document.querySelectorAll(".menu-item")]
			.find((item) => item.textContent.includes(text)), `menu item ${text}`);
		item.click();
	};
	await wait(() => leaf?.view?.file && app.plugins.getPlugin("flexible-tasks"), "restore workspace and load plugin");
	return scenario({ app, leaf, reading, cells, file, disk, wait, check, open, mode, context, pick }, ...args);
}

try {
	if (phase === "startup" || phase === "restored") {
		await run("cold startup restores the Dashboard in Reading view", async ({ leaf, cells, wait, check }, restored) => {
			check(leaf.view.file.path, "Dashboard.md", "Restored note");
			check(leaf.view.getMode(), "preview", "Restored view mode");
			await wait(() => cells().length >= 4, "first dashboard checkboxes");
			check(cells()[0].checked, restored, "Persisted first checkbox");
		}, phase === "restored");
		if (phase === "startup") {
			await run("scrolling reaches 9 sections, 65 rows and 260 interactive checkboxes", async ({ reading, wait, check }) => {
				const viewport = reading().querySelector(".markdown-preview-view") ?? reading();
				check(viewport.classList.contains("markdown-preview-view"), true, "Native scroll container");
				const positions = new Map();
				const collect = () => {
					for (const row of viewport.querySelectorAll("table tbody tr")) {
						if (!row.cells[0]?.textContent.trim().startsWith("Appello ")) continue;
						positions.set(row.cells[0].textContent.trim(), row.querySelectorAll(".tot-cell-task > input").length);
					}
				};
				for (let y = 0; y <= viewport.scrollHeight; y += Math.max(150, viewport.clientHeight / 2)) {
					viewport.scrollTop = y;
					await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
					collect();
				}
				await wait(() => { collect(); return positions.size === 65; }, "all Dashboard rows");
				check([...positions.values()].reduce((sum, count) => sum + count, 0), 260, "Checkbox total");
				viewport.scrollTop = 0;
				await wait(() => viewport.textContent.includes("Appello 01"), "revisit first section");
				check(positions.get("Appello 01"), 4, "Revisited first row");
			});
		}
	} else {
		await run("detached render section is decorated immediately and cleaned on unload", ({ app, check }) => {
			const plugin = app.plugins.getPlugin("flexible-tasks");
			const section = document.createElement("div");
			section.innerHTML = "<table><thead><tr><th>Title</th></tr></thead><tbody><tr><td>- [ ] <strong>label</strong></td></tr></tbody></table>";
			let child;
			const info = { text: "| Title |\n| --- |\n| - [ ] **label** |", lineStart: 0, lineEnd: 2 };
			const ctx = { sourcePath: "Issue 2.md", getSectionInfo: () => info, addChild: (render) => { child = render; child.load(); } };
			plugin.processSection(section, ctx);
			plugin.processSection(section, ctx);
			check(section.isConnected, false, "Section has no live pane");
			check(section.querySelectorAll(".tot-cell-task input").length, 1, "Single decorated checkbox");
			check(section.querySelector("strong").textContent, "label", "Original markup retained");
			child.unload();
			check(section.querySelector("td").innerHTML, "- [ ] <strong>label</strong>", "Detached cleanup");
		});

		await run("unloading during settings loading cancels late initialization", async ({ app, check }) => {
			const active = app.plugins.getPlugin("flexible-tasks");
			const late = new active.constructor(app, active.manifest);
			let resolveSettings;
			late.loadData = () => new Promise((resolve) => { resolveSettings = resolve; });
			let registrations = 0;
			late.registerMarkdownPostProcessor = () => { registrations++; };
			const loading = late.onload();
			late.onunload();
			resolveSettings({});
			await loading;
			check(registrations, 0, "Post-processors registered after unload");
			check(late.active, false, "Unloaded plugin never activated");
		});

		await run("checking and unchecking the same cell keeps cached render sections consistent", async (t, initial) => {
			const name = "Dashboard.md";
			await t.open(name);
			const renderer = t.leaf.view.previewMode.renderer;
			renderer.previewEl.scrollTop = 0;
			const box = () => Array.from(t.reading().querySelectorAll("tr"))
				.find((row) => row.cells[0]?.textContent.trim() === "Appello 01")
				?.querySelector(".tot-cell-task input");
			const initialBox = await t.wait(() => box(), "initial dashboard cell");
			const checked = initial.replace("| Appello 01 | - [ ]", "| Appello 01 | - [x]");
			const plugin = t.app.plugins.getPlugin("flexible-tasks");
			const queueRender = renderer.queueRender;
			// Retain the old section while the write finishes, as can happen when
			// the renderer is busy. Obsidian can later reuse that section by HTML.
			renderer.queueRender = () => {};
			try {
				initialBox.click();
				await t.wait(async () => await t.disk(name) === checked &&
					plugin.writes.get(t.file(name))?.count === 0, "write while the old section is retained");
				t.check(initialBox.isConnected, true, "Old section retained");
				t.check(initialBox.checked, false, "Original section retains its original status");
			} finally {
				renderer.queueRender = queueRender;
				renderer.queueRender();
			}
			await t.wait(() => renderer.lastText === checked && box()?.checked, "checked state after redraw");
			t.check(box().parentElement.textContent, "", "Standalone checkbox has no stray text");
			box().click();
			await t.wait(async () => await t.disk(name) === initial && renderer.lastText === initial &&
				box()?.checked === false, "same cell unchecked after redraw");
		}, dashboardFixture());

		await run("issue #2, Live Preview switch, selection, deselection and rapid clicks", async (t, initial) => {
			const name = "Issue 2.md";
			await t.open(name, "source");
			await t.wait(() => t.leaf.view.contentEl.querySelector("table.table-editor"), "native Live Preview table");
			t.check(t.leaf.view.contentEl.querySelectorAll(".markdown-source-view .tot-cell-task").length, 0, "Native Live Preview table DOM");
			await t.mode("preview");
			await t.wait(() => t.cells().length === 2, "Reading boxes");
			t.check(t.leaf.view.contentEl.querySelectorAll("table").length, 2, "Both table DOMs present");
			const row = "| - [ ] | - [x] |";
			const bothChecked = initial.replace(row, "| - [x] | - [x] |");
			t.cells()[0].click();
			await t.wait(async () => await t.disk(name) === bothChecked, "check first cell");
			const swapped = initial.replace(row, "| - [x] | - [ ] |");
			t.cells()[1].click();
			await t.wait(async () => await t.disk(name) === swapped, "uncheck second cell");
			for (const index of [0, 0, 1, 0, 1]) t.cells()[index].click();
			const plugin = t.app.plugins.getPlugin("flexible-tasks");
			const final = initial.replace(row, "| - [ ] | - [ ] |");
			await t.wait(async () => plugin.writes.get(t.file(name))?.count === 0 &&
				await t.disk(name) === final && t.cells().length === 2 &&
				t.cells().every((input) => !input.checked), "serialize all five rapid clicks");
			await t.mode("source", true);
			await t.wait(() => t.leaf.view.editor.getValue() === final, "source content after toggles");
			await t.mode("preview");
			await t.wait(() => t.cells().length === 2 && t.cells().every((input) => !input.checked), "Reading redisplays source status");
		}, issueFixture);

		await run("two Reading panes and rapid note switches preserve checkbox identity", async (t) => {
			const name = "Issue 2.md";
			const other = t.app.workspace.getLeaf("split");
			try {
				await t.open(name, "preview", false, other);
				await t.wait(() => t.cells(other).length === 2, "boxes in second pane");
				const initial = await t.disk(name);
				t.cells()[0].click();
				t.cells(other)[0].click();
				t.cells(other)[1].click();
				const after = initial.replace("| - [ ] | - [ ] |", "| - [ ] | - [x] |");
				await t.wait(async () => await t.disk(name) === after, "writes from both panes");
				await t.wait(() => t.cells()[1]?.checked && t.cells(other)[1]?.checked, "both panes show latest state");
				await t.open("Edge.md", "preview", false, other);
				await t.open("Dashboard.md", "preview", false, other);
				await t.open(name, "preview", false, other);
				await t.wait(() => t.cells(other).length === 2 && t.cells(other)[1].checked, "reattached pane");
				t.check(await t.disk(name), after, "Switching notes leaves Markdown intact");
			} finally {
				other.detach();
			}
		});

		await run("a delayed Reading pane can act after two completed writes in its peer", async (t) => {
			const name = "Peer preview.md";
			const row = "| - [ ] | - [ ] | - [ ] |";
			const initial = `# Peer preview\n\n| A | B | C |\n| --- | --- | --- |\n${row}\n`;
			await t.app.vault.create(name, initial);
			await t.open(name);
			const other = t.app.workspace.getLeaf("split");
			try {
				await t.open(name, "preview", false, other);
				await t.wait(() => t.cells().length === 3 && t.cells(other).length === 3, "both Reading panes");
				const renderer = other.view.previewMode.renderer;
				const queueRender = renderer.queueRender;
				renderer.queueRender = () => {};
				try {
					t.cells()[0].click();
					await t.wait(() => t.cells()[0]?.checked, "first save and redraw");
					t.cells()[1].click();
					await t.wait(() => t.cells()[1]?.checked, "second save and redraw");
					t.check(renderer.lastText, initial, "Peer still shows original revision");
					t.cells(other)[2].click();
					const expected = initial.replace(row, "| - [x] | - [x] | - [x] |");
					await t.wait(async () => await t.disk(name) === expected, "third cell saved from delayed pane");
				} finally {
					renderer.queueRender = queueRender;
				}
			} finally {
				other.detach();
			}
		});

		await run("duplicates, escaped pipes, loose block tasks, quoted tables, links and custom menu", async (t) => {
			const name = "Edge.md";
			t.app.vault.setConfig("nativeMenus", false);
			if (t.app.plugins.getPlugin("obsidian-tasks-plugin")) {
				await t.app.plugins.disablePlugin("obsidian-tasks-plugin");
				window.restoreTasksForDashboard = true;
			}
			await t.open(name);
			await t.wait(() => t.cells().length === 8, "all edge task cells");
			const root = t.reading();
			t.check(root.querySelectorAll("th .tot-cell-task").length, 0, "Header unmodified");
			t.check(root.querySelector("td .tot-cell-task strong").textContent, "bold", "Bold label");
			t.check(root.querySelector("td .tot-cell-task a").textContent, "link", "Link preserved");
			const base = await t.disk(name);
			const loose = root.querySelector(".tot-block-task > p > input");
			t.check(loose.dataset.task, "!", "Custom status uses themed fallback");
			t.context(loose);
			await t.pick("In progress");
			const afterBlock = base.replace("- [@] Parent", "- [/] Parent");
			await t.wait(async () => await t.disk(name) === afterBlock, "loose parent menu updates only parent");
			const escaped = t.cells()[2];
			t.context(escaped);
			await t.pick("Cancelled");
			const afterCell = afterBlock.replace("| a \\| b | - [ ] |", "| a \\| b | - [-] |");
			await t.wait(async () => await t.disk(name) === afterCell, "escaped pipe and cell status");
			t.cells()[4].click();
			await t.wait(async () => await t.disk(name) === afterCell.replace("> | - [ ] | - [/] |", "> | - [x] | - [/] |"), "quoted table toggle");
			const plugin = t.app.plugins.getPlugin("flexible-tasks");
			plugin.settings.styleBlockTasks = false;
			await plugin.saveSettings();
			await t.wait(() => t.cells().length === 8 && !root.querySelector(".tot-block-task"), "disable optional block menu");
			plugin.settings.styleBlockTasks = true;
			await plugin.saveSettings();
			await t.wait(() => root.querySelector(".tot-block-task > p > input"), "restore optional block menu");
		});

		await run("editor submenu targets the actual marker and rejects a stale selection", async (t) => {
			const name = "Edge.md";
			await t.open(name, "source", true);
			const view = t.leaf.view;
			const editor = view.editor;
			const line = 15;
			const menu = () => {
				const choices = [];
				const stub = (items) => ({ addItem(callback) {
					let entry = {};
					const item = {
						setTitle(title) { entry.title = title; return item; },
						setChecked() { return item; },
						setSubmenu() { return stub(items); },
						onClick(select) { entry.select = select; return item; },
					};
					callback(item);
					if (entry.select) items.push(entry);
				} });
				t.app.plugins.getPlugin("flexible-tasks").addStatusSubmenu(stub(choices), editor, view);
				return choices.find(({ title }) => title === "Question  [?]");
			};
			editor.setCursor({ line, ch: editor.getLine(line).indexOf("bold") });
			const initial = editor.getValue();
			menu().select();
			const expected = initial.replace("- [x] **bold**", "- [?] **bold**");
			t.check(editor.getValue(), expected, "Correct marker in formatted label cell");
			const stale = menu();
			editor.replaceRange(" changed", { line, ch: editor.getLine(line).length });
			const changed = editor.getValue();
			stale.select();
			t.check(editor.getValue(), changed, "Stale menu does not update source");
			await view.save();
		});

		await run("atomic write protects a reordered file and a dirty split editor", async (t) => {
			const name = "Issue 2.md";
			await t.open(name);
			await t.wait(() => t.cells().length === 2, "baseline reading");
			const initial = await t.disk(name);
			const external = initial.replace("# Issue 2", "# External change\n\nExtra paragraph.");
			const original = t.app.vault.process;
			let raced = false;
			t.app.vault.process = async function (file, change) {
				await t.app.vault.modify(file, external);
				try { return await original.call(this, file, change); }
				finally { raced = true; }
			};
			try {
				t.cells()[0].click();
				await t.wait(() => raced, "concurrent source mutation");
				t.check(await t.disk(name), external, "External revision preserved");
			} finally {
				t.app.vault.process = original;
			}
			await t.wait(() => t.reading().textContent.includes("Extra paragraph."), "updated external preview");

			const split = t.app.workspace.getLeaf("split");
			try {
				await t.open(name, "source", true, split);
				const editor = split.view.editor;
				editor.replaceRange("Draft ", { line: 0, ch: 2 });
				const draft = editor.getValue();
				let done = false;
				t.app.vault.process = async function (file, change) {
					try { return await original.call(this, file, change); }
					finally { done = true; }
				};
				t.cells()[0].click();
				await t.wait(() => done, "attempt with dirty editor");
				t.check(editor.getValue(), draft, "Draft preserved");
				await split.view.save();
				t.check(await t.disk(name), draft, "No unintended table change");
			} finally {
				t.app.vault.process = original;
				split.detach();
			}
		});

		await run("BOM and CRLF survive a real Obsidian write", async (t) => {
			await t.open("CRLF.md");
			await t.wait(() => t.cells().length === 2, "CRLF table");
			t.cells()[0].click();
			await t.wait(async () => (await t.disk("CRLF.md")).includes("| - [x] | - [x] |"), "CRLF persisted");
		});
		assert.equal(readFileSync(join(vault, "CRLF.md"), "utf8"),
			"\uFEFF" + issueFixture.replace("| - [ ] | - [x] |", "| - [x] | - [x] |").replace(/\n/g, "\r\n").trimEnd());

		await run("a failed write preserves the displayed state and a retry succeeds", async (t) => {
			const name = "Issue 2.md";
			await t.open(name);
			await t.wait(() => t.cells().length === 2 && !t.cells()[0].checked, "unchecked task");
			const initial = await t.disk(name);
			const original = t.app.vault.process;
			const plugin = t.app.plugins.getPlugin("flexible-tasks");
			let attempted = false;
			t.app.vault.process = async () => {
				attempted = true;
				throw new Error("Injected write failure");
			};
			try {
				t.cells()[0].click();
				await t.wait(() => attempted && plugin.writes.get(t.file(name))?.count === 0, "failed write settled");
				t.check(t.cells()[0].checked, false, "Checkbox after failed write");
				t.check(await t.disk(name), initial, "File after failed write");
			} finally {
				t.app.vault.process = original;
			}
			t.cells()[0].click();
			const expected = initial.replace("| - [ ] | - [x] |", "| - [x] | - [x] |");
			await t.wait(async () => await t.disk(name) === expected && t.cells()[0].checked, "retry succeeds");
		});

		await run("renaming an open note keeps its existing checkboxes interactive", async (t) => {
			const name = "Issue 2.md";
			const moved = "Moved issue.md";
			const file = t.file(name);
			const initial = await t.disk(name);
			const expected = initial.replace("| - [x] | - [x] |", "| - [x] | - [ ] |");
			try {
				await t.app.fileManager.renameFile(file, moved);
				await t.wait(() => t.leaf.view.file?.path === moved && t.cells()[1]?.checked, "renamed open note");
				t.cells()[1].click();
				await t.wait(async () => await t.disk(moved) === expected, "toggle persists after rename");
			} finally {
				if (file.path === moved) await t.app.fileManager.renameFile(file, name);
			}
		});

		await run("disabling and re-enabling releases and rebuilds preview sections", async (t) => {
			await t.open("Edge.md");
			await t.wait(() => t.cells().length === 8, "edge before unload");
			const plugin = t.app.plugins.getPlugin("flexible-tasks");
			await t.app.plugins.disablePlugin("flexible-tasks");
			t.check(t.cells().length, 0, "Checkboxes removed on unload");
			t.check(plugin.rendered.size, 0, "Children released on unload");
			await t.wait(() => t.reading().querySelector("table strong")?.textContent === "bold", "Markdown markup restored");
			await t.app.plugins.enablePlugin("flexible-tasks");
			await t.wait(() => t.cells().length === 8, "backfill existing preview");
		});

		await run("the default and installed themes style native checkbox controls", async (t) => {
			const css = t.app.customCss;
			const initial = css.theme;
			const themes = ["", ...["Minimal", "Sereno"].filter((theme) => css.isThemeInstalled(theme))];
			const sizes = {};
			try {
				for (const theme of themes) {
					await css.setTheme(theme);
					await t.wait(() => css.theme === theme && t.cells().length === 8, "theme applied");
					const input = t.cells().find((input) => !input.checked);
					const native = t.reading().querySelector("li:not(.tot-cell-task) input:not(:checked)");
					const styled = (input) => [getComputedStyle(input).width, getComputedStyle(input).height,
						getComputedStyle(input).borderRadius].join("/");
					t.check(styled(input), styled(native), "Native geometry and border radius");
					t.check(input.getBoundingClientRect().width > 0, true, "Visible table checkbox");
					t.check(input.tabIndex, 0, "Keyboard focus");
					const checked = t.cells().find((input) => input.checked && input.parentElement.textContent.trim() === "");
					t.check(checked.parentElement.textContent, "", "No stray text beside a checked box");
					sizes[theme || "default"] = styled(input);
				}
			} finally {
				await css.setTheme(initial);
			}
			return sizes;
		});

		await run("Dashboard updates DataviewJS/Tasks when installed and persists before app restart", async (t, initial) => {
			if (window.restoreTasksForDashboard) await t.app.plugins.enablePlugin("obsidian-tasks-plugin");
			await t.open("Dashboard.md");
			const viewport = t.reading().querySelector(".markdown-preview-view") ?? t.reading();
			viewport.scrollTop = 0;
			await t.wait(() => t.cells().length >= 4, "Dashboard first row");
			const dataview = !!t.app.plugins.getPlugin("dataview");
			const tasks = !!t.app.plugins.getPlugin("obsidian-tasks-plugin");
			const summary = () => t.reading().querySelector(".dataview.table-view-table tbody tr")?.textContent;
			if (dataview) await t.wait(() => /65\s*260\s*65/.test(summary() ?? ""), "DataviewJS counts 65/260/65");
			const row = "| Appello 01 | - [ ] | - [ ] | - [x] | - [ ] |";
			t.cells()[0].click();
			await t.wait(async () => await t.disk("Dashboard.md") === initial.replace(row, row.replace("- [ ]", "- [x]")), "first dashboard write");
			if (dataview) await t.wait(() => /65\s*260\s*66/.test(summary() ?? ""), "DataviewJS counts 65/260/66 after toggle");
			if (tasks) {
				viewport.scrollTop = viewport.scrollHeight;
				await t.wait(() => t.reading().querySelector(".block-language-tasks")?.textContent.includes("Promemoria sintetico"), "Tasks reads the native task");
				viewport.scrollTop = 0;
				await t.wait(() => t.cells().length >= 4 && t.cells()[0].checked, "dashboard first row restored for restart");
			}
			return { dataview, tasks };
		}, dashboardFixture());
	}
} finally {
	socket.close();
}
