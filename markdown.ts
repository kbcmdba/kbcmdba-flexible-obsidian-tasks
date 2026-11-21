// SPDX-License-Identifier: GPL-2.0-only

export interface Marker {
	column: number;
	raw: string;
	status: string;
	identity: string;
}

interface Field {
	start: number;
	text: string;
}

interface Row {
	fields: Field[];
	hasPipe: boolean;
	leadingPipe: boolean;
}

interface Table {
	header: number;
	end: number;
	columns: number;
}

const CELL_TASK = /^\s*[-*+]\s+\[(\\\||.)\]/u;
const LIST_START = /^([ \t]*)([-*+]|\d{1,9}[.)])([ \t]+)/;
const LIST_TASK = /^[ \t]*(?:[-*+]|\d{1,9}[.)])[ \t]+\[(.)\]/u;
const TABLE_DELIMITER = /^:?-+:?$/;
const QUOTE = /^(?:[ \t]*>[ \t]?)+/;

export function normalized(text: string): string {
	return text.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");
}

function quotePrefix(line: string): string {
	return QUOTE.exec(line)?.[0] ?? "";
}

function marker(field: Field, pattern: RegExp): Marker | null {
	const match = pattern.exec(field.text);
	if (!match) return null;
	const raw = match[1];
	const start = match[0].length - raw.length - 1;
	return {
		column: field.start + start,
		raw,
		status: raw === "\\|" ? "|" : raw,
		identity: field.text.slice(0, start) + field.text.slice(start + raw.length),
	};
}

/** Split on unescaped pipes and keep each field's source column. */
function splitRow(line: string, offset: number): Row {
	const result: Field[] = [];
	let start = offset;
	let escaped = false;
	for (let i = offset; i < line.length; i++) {
		const char = line[i];
		if (char === "|" && !escaped) {
			result.push({ start, text: line.slice(start, i) });
			start = i + 1;
		}
		escaped = char === "\\" && !escaped;
	}
	const hasPipe = start !== offset;
	result.push({ start, text: line.slice(start) });
	const leadingPipe = hasPipe && !result[0].text.trim();
	if (leadingPipe) result.shift();
	if (hasPipe && !result[result.length - 1]?.text.trim()) result.pop();
	return { fields: result, hasPipe, leadingPipe };
}

export function cellMarker(line: string, cell: number): Marker | null {
	const field = splitRow(line, quotePrefix(line).length).fields[cell];
	return field ? marker(field, CELL_TASK) : null;
}

export function listMarker(line: string): Marker | null {
	const start = quotePrefix(line).length;
	return marker({ start, text: line.slice(start) }, LIST_TASK);
}

export function renderedMarker(text: string): { status: string; prefix: string } | null {
	const match = CELL_TASK.exec(text);
	return match ? { status: match[1], prefix: match[0] + (/^[ \t]*/.exec(text.slice(match[0].length))?.[0] ?? "") } : null;
}

function quoteDepth(prefix: string): number {
	return prefix.split(">").length - 1;
}

function indentation(whitespace: string): number {
	let column = 0;
	for (const char of whitespace) column += char === "\t" ? 4 - column % 4 : 1;
	return column;
}

/** Mask regions that cannot contain Markdown tasks or tables. */
function markdownLines(lines: readonly string[], start: number, end: number): string[] {
	const result: string[] = [];
	const first = lines[0];
	let frontmatter = start === 0 && /^---[ \t]*$/.test(first) &&
		lines.slice(1).some((line) => /^(?:---|\.\.\.)[ \t]*$/.test(line));
	let fence: { char: string; length: number; depth: number; indent: number } | null = null;
	let comment: string | undefined;
	const listIndents: number[][] = [];
	for (let i = start; i <= end; i++) {
		const line = lines[i];
		const prefix = quotePrefix(line);
		const depth = quoteDepth(prefix);
		const body = line.slice(prefix.length);
		const indent = indentation(/^[ \t]*/.exec(body)?.[0] ?? "");
		listIndents.length = depth + 1;
		const indents = listIndents[depth] ??= [];
		if (fence && (depth < fence.depth || (depth === fence.depth && indent < fence.indent && body.trim()))) {
			fence = null;
		}
		if (frontmatter) {
			if (i > 0 && /^(?:---|\.\.\.)[ \t]*$/.test(line)) frontmatter = false;
		} else if (fence) {
			const closing = depth === fence.depth && indent - fence.indent < 4
				? /^[ \t]*(`{3,}|~{3,})[ \t]*$/.exec(body)?.[1]
				: undefined;
			if (closing?.[0] === fence.char && closing.length >= fence.length) fence = null;
		} else if (comment) {
			if (body.includes(comment)) comment = undefined;
		} else if (/^[ \t]*(?:<!--|%%)/.test(body)) {
			const opening = body.trimStart().startsWith("<!--") ? "<!--" : "%%";
			const closing = opening === "<!--" ? "-->" : "%%";
			if (!body.includes(closing, body.indexOf(opening) + opening.length)) comment = closing;
		} else {
			while (body.trim() && indents.length && indent < indents[indents.length - 1]) indents.pop();
			const base = indents[indents.length - 1] ?? 0;
			if (indent - base >= 4) {
				result.push("");
				continue;
			}
			const list = LIST_START.exec(body);
			const contentIndent = list ? indent + list[2].length + Math.min(indentation(list[3]), 4) : base;
			if (list) indents.push(contentIndent);
			const opening = /^[ \t]*(`{3,}|~{3,})/.exec(list ? body.slice(list[0].length) : body)?.[1];
			if (!opening) {
				result.push(line);
				continue;
			}
			fence = { char: opening[0], length: opening.length, depth, indent: contentIndent };
		}
		result.push("");
	}
	return result;
}

export function findTables(lines: readonly string[], start: number, end: number): Table[] {
	return tablesIn(markdownLines(lines, start, end), start);
}

function tablesIn(source: readonly string[], start: number): Table[] {
	const tables: Table[] = [];
	for (let i = 0; i + 1 < source.length; i++) {
		const prefix = quotePrefix(source[i]);
		const delimiterPrefix = quotePrefix(source[i + 1]);
		const depth = quoteDepth(prefix);
		if (depth !== quoteDepth(delimiterPrefix)) continue;
		const heading = splitRow(source[i], prefix.length);
		const delimiter = splitRow(source[i + 1], delimiterPrefix.length);
		const columns = heading.fields.length;
		if ((!heading.hasPipe && !delimiter.hasPipe) || heading.leadingPipe !== delimiter.leadingPipe ||
			!columns || columns !== delimiter.fields.length ||
			!delimiter.fields.every(({ text }) => TABLE_DELIMITER.test(text.trim()))) {
			continue;
		}
		const header = i++;
		while (i + 1 < source.length) {
			const row = source[i + 1];
			const rowPrefix = quotePrefix(row);
			const parsed = splitRow(row, rowPrefix.length);
			if (depth !== quoteDepth(rowPrefix) || !parsed.hasPipe || heading.leadingPipe !== parsed.leadingPipe) break;
			i++;
		}
		tables.push({ header: start + header, end: start + i, columns });
	}
	return tables;
}

export function editorMarker(text: string, line: number, column: number): Marker | null {
	const lines = normalized(text).split("\n");
	// Editor offsets include a BOM if the editor exposes it.
	const source = markdownLines(lines, 0, lines.length - 1);
	if (!source[line]) return null;
	const table = tablesIn(source, 0).find(({ header, end }) => line >= header && line <= end);
	let target: Marker | null = null;
	if (!table) {
		// A quoted or ordered list task still starts with its own list marker.
		target = listMarker(lines[line]);
	} else if (line > table.header + 1) {
		let distance = Infinity;
		const fields = splitRow(lines[line], quotePrefix(lines[line]).length).fields;
		for (const field of fields.slice(0, table.columns)) {
			const candidate = marker(field, CELL_TASK);
			if (!candidate) continue;
			if (column >= field.start && column < field.start + field.text.length) {
				target = candidate;
				break;
			}
			const gap = Math.abs(column - candidate.column);
			if (gap < distance) {
				distance = gap;
				target = candidate;
			}
		}
	}
	if (target && line === 0 && text.startsWith("\uFEFF")) target.column++;
	return target;
}

export function replaceStatus(text: string, line: number, at: Marker, status: string): string {
	if (status === at.status) return text;
	const lines = text.split("\n");
	const current = lines[line];
	const column = at.column + (line === 0 && current.startsWith("\uFEFF") ? 1 : 0);
	const raw = status === "|" ? "\\|" : status;
	lines[line] = current.slice(0, column) + raw + current.slice(column + at.raw.length);
	return lines.join("\n");
}
