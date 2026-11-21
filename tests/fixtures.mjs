// SPDX-License-Identifier: GPL-2.0-only

export function dashboardFixture() {
	const lines = ["# Dashboard universitaria sintetica", "", "```dataviewjs",
		"const md = await dv.io.load(dv.current().file.path);",
		"const rows = md.split('\\n').filter(line => /^\\| Appello \\d/.test(line));",
		"const marks = rows.flatMap(line => [...line.matchAll(/- \\[([ x])\\]/g)]);",
		"dv.table(['Appelli', 'Esercizi', 'Completati'], [[rows.length, marks.length, marks.filter(m => m[1] === 'x').length]]);",
		"```", ""];
	let exam = 0;
	for (let year = 1; year <= 9; year++) {
		lines.push(`## Anno ${year}`, "", "| Appello | E1 | E2 | E3 | E4 |", "| --- | --- | --- | --- | --- |");
		const exams = year <= 2 ? 8 : 7;
		for (let row = 0; row < exams; row++) {
			exam++;
			lines.push(`| Appello ${String(exam).padStart(2, "0")} | - [ ] | - [ ] | - [x] | - [ ] |`);
		}
		lines.push("");
	}
	lines.push("- [ ] Promemoria sintetico", "", "```tasks", "path includes Dashboard.md", "```", "");
	return lines.join("\n");
}

export const edgeFixture = [
	"# Edge cases", "", "- [@] Parent", "", "    - [ ] Child", "", "~~~",
	"- [ ] Fake task", "| Fake | Table |", "| --- | --- |", "| - [ ] | - [ ] |", "~~~", "",
	"| Exercises | - [ ] Header |", "| :--- | ---: |", "| - [ ] | - [x] **bold** [link](https://example.org) |",
	"| a \\| b | - [ ] |", "| - [X] |", "", "> [!note]", "> | Exercises | Other |",
	"> | --- | --- |", "> | - [ ] | - [/] |", "", "| Exercises | Other |",
	"| --- | --- |", "| - [ ] | - [ ] |", "", "- [ ] Final", "",
].join("\n");

export const issueFixture = [
	"# Issue 2", "", "| col1 | col2 |", "| --- | --- |", "| - [ ] | - [x] |", "| | |", "",
].join("\n");
