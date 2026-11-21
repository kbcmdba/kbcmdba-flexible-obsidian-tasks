// SPDX-License-Identifier: GPL-2.0-only

import { copyFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { dashboardFixture, edgeFixture, issueFixture } from "./fixtures.mjs";

const repo = dirname(dirname(fileURLToPath(import.meta.url)));
const base = join(repo, "test-vault");
mkdirSync(base, { recursive: true });
const root = mkdtempSync(join(base, "audit-"));
const profile = join(root, "profile");
const vault = join(root, "vault");
const config = join(vault, ".obsidian");
const plugin = join(config, "plugins", "flexible-tasks");
mkdirSync(profile);
mkdirSync(plugin, { recursive: true });

for (const file of ["main.js", "manifest.json", "styles.css"]) copyFileSync(join(repo, file), join(plugin, file));
writeFileSync(join(vault, "Dashboard.md"), dashboardFixture());
writeFileSync(join(vault, "Issue 2.md"), issueFixture);
writeFileSync(join(vault, "Edge.md"), edgeFixture);
writeFileSync(join(vault, "CRLF.md"), "\uFEFF" + issueFixture.replace(/\n/g, "\r\n").trimEnd());
const json = (file, data) => writeFileSync(file, JSON.stringify(data, null, 2));
json(join(config, "community-plugins.json"), ["flexible-tasks"]);
json(join(config, "app.json"), { livePreview: true });
json(join(config, "appearance.json"), { nativeMenus: false });
json(join(config, "workspace.json"), {
	main: { id: "da12cd34ef56ab78", type: "split", direction: "vertical", children: [
		{ id: "ba12cd34ef56ab78", type: "tabs", children: [
			{ id: "ca12cd34ef56ab78", type: "leaf", state: {
				type: "markdown", state: { file: "Dashboard.md", mode: "preview", source: false },
				icon: "lucide-file", title: "Dashboard",
			} },
		] },
	] },
	active: "ca12cd34ef56ab78",
	lastOpenFiles: ["Dashboard.md"],
});
json(join(profile, "obsidian.json"), { vaults: { ab12cd34ef56ab78: { path: vault, ts: Date.now(), open: true } } });
process.stdout.write(`${root}\n`);
