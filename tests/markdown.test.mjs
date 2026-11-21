// SPDX-License-Identifier: GPL-2.0-only

import assert from "node:assert/strict";
import { test } from "node:test";
import { buildSync } from "esbuild";
import { dashboardFixture, edgeFixture, issueFixture } from "./fixtures.mjs";

const { text } = buildSync({
	entryPoints: ["markdown.ts"], bundle: true, write: false, format: "esm",
}).outputFiles[0];
const { cellMarker, editorMarker, findTables, listMarker, normalized, renderedMarker, replaceStatus } =
	await import(`data:text/javascript;base64,${Buffer.from(text).toString("base64")}`);

test("toggling in either direction targets the clicked column and preserves the rest of the note", () => {
	const row = 4;
	const check = cellMarker(issueFixture.split("\n")[row], 0);
	const uncheck = cellMarker(issueFixture.split("\n")[row], 1);
	const checked = replaceStatus(issueFixture, row, check, "x");
	assert.equal(checked, issueFixture.replace("| - [ ] | - [x] |", "| - [x] | - [x] |"));
	assert.equal(replaceStatus(checked, row, uncheck, " "), issueFixture.replace("| - [ ] | - [x] |", "| - [x] | - [ ] |"));
});

test("source ranges map real tables around fences and callouts", () => {
	const lines = edgeFixture.split("\n");
	assert.deepEqual(findTables(lines, 0, lines.length - 1), [
		{ header: 13, end: 17, columns: 2 },
		{ header: 20, end: 22, columns: 2 },
		{ header: 24, end: 26, columns: 2 },
	]);
	assert.equal(cellMarker(lines[15], 0).status, " ");
	assert.equal(cellMarker(lines[17], 0).status, "X");
	assert.equal(cellMarker(lines[17], 1), null);
	assert.equal(cellMarker(lines[22], 1).status, "/");
});

test("field splitting handles escaped pipes, backslash pairs, optional delimiters and missing fields", () => {
	assert.equal(cellMarker("| before \\| still before | - [x] text |", 1).status, "x");
	assert.equal(cellMarker("| before \\\\| - [/] text |", 1).status, "/");
	assert.equal(cellMarker("plain | | - [!] text", 2).status, "!");
	assert.equal(cellMarker("| - [ ] |", 1), null);
	const line = "| - [\\|] text | - [🟢] **label** |";
	assert.equal(cellMarker(line, 0).status, "|");
	assert.equal(cellMarker(line, 1).status, "🟢");
	assert.equal(renderedMarker("- [🟢] label").prefix, "- [🟢] ");
	assert.equal(replaceStatus(line, 0, cellMarker(line, 1), "x"), "| - [\\|] text | - [x] **label** |");
});

test("replaces just the status with BOM, CRLF, trailing spaces and no final newline", () => {
	const raw = "\uFEFF| - [X] | - [ ] |  \r\n| a | b |\r\n- [ ] final";
	const target = cellMarker(normalized(raw).split("\n")[0], 0);
	assert.equal(replaceStatus(raw, 0, target, " "), raw.replace("[X]", "[ ]"));
	assert.equal(replaceStatus(raw, 0, target, "X"), raw);
});

test("editor menu chooses the real task in the cell containing the cursor", () => {
	const source = "| A | B |\n| --- | --- |\n| - [ ] long label and [q] | - [x] |";
	const row = source.split("\n")[2];
	const target = editorMarker(source, 2, row.indexOf("[q]") + 1);
	assert.equal(target.status, " ");
	assert.equal(target.column, row.indexOf("[ ]") + 1);
	assert.equal(editorMarker(source, 2, row.indexOf("[x]") + 1).status, "x");
	assert.equal(editorMarker("- [X] [q] tail", 0, 9).column, 3);
	assert.equal(editorMarker("> 2) [!] ordered", 0, 15).status, "!");
});

test("editor menu ignores headers, fenced and indented code, properties and pipe prose", () => {
	const source = edgeFixture;
	assert.equal(editorMarker(source, 7, 4), null);
	assert.equal(editorMarker(source, 10, 6), null);
	assert.equal(editorMarker(source, 13, 18), null);
	assert.equal(editorMarker(source, 4, 10).status, " ");
	assert.equal(editorMarker("# Note\n\n    - [ ] code", 2, 8), null);
	assert.equal(editorMarker("---\n- [ ] property\n---", 1, 3), null);
	assert.equal(editorMarker("plain | [x] | text", 0, 9), null);
	assert.equal(editorMarker("plain | - [x] | text", 0, 11), null);
	assert.equal(editorMarker("A | B\n--- | ---\n| - [x] | - [ ] |", 2, 6), null);
	assert.equal(editorMarker("%%\n- [x] comment\n%%", 1, 4), null);
	assert.equal(editorMarker("<!--\n- [x] comment\n-->", 1, 4), null);
});

test("editor menu ignores code fences in list items and quoted examples inside fences", () => {
	const listFence = [
		"- ```markdown", "  | A | B |", "  | --- | --- |", "  | - [ ] Example | - [x] Sample |",
		"  ```", "- [x] Real task",
	].join("\n");
	assert.equal(editorMarker(listFence, 3, 8), null);
	assert.equal(editorMarker(listFence, 5, 5).status, "x");

	const quotedExample = ["```markdown", "> ```", "- [ ] Example", "```", "- [x] Real task"].join("\n");
	assert.equal(editorMarker(quotedExample, 2, 4), null);
	assert.equal(editorMarker(quotedExample, 4, 4).status, "x");
});

test("block positions distinguish loose, nested, ordered and repeated tasks", () => {
	assert.equal(listMarker("- [@] Parent").status, "@");
	assert.equal(listMarker("    - [ ] Child").column, 7);
	assert.equal(listMarker("> > 3. [/] Ordered").status, "/");
	const text = "- [x] same\n- [x] same";
	assert.equal(replaceStatus(text, 1, listMarker(text.split("\n")[1]), "?"), "- [x] same\n- [?] same");
});

test("the dashboard fixture maps 260 tasks across 65 rows and 9 tables", () => {
	const lines = dashboardFixture().split("\n");
	const tables = findTables(lines, 0, lines.length - 1);
	assert.equal(tables.length, 9);
	assert.equal(tables.reduce((sum, table) => sum + table.end - table.header - 1, 0), 65);
	let count = 0;
	for (const { header, end, columns } of tables) {
		for (let line = header + 2; line <= end; line++) {
			for (let cell = 0; cell < columns; cell++) {
				if (cellMarker(lines[line], cell)) count++;
			}
		}
	}
	assert.equal(count, 260);
});
