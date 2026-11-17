import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type FileSearchMatch, grep, searchFiles } from "../native/index.js";

let root: string;

beforeEach(async () => {
	root = await fs.mkdtemp(path.join(os.tmpdir(), "natives-file-search-"));
});
afterEach(async () => {
	await fs.rm(root, { recursive: true, force: true });
});

async function write(name: string, content = "needle\n") {
	const file = path.join(root, name);
	await fs.mkdir(path.dirname(file), { recursive: true });
	await Bun.write(file, content);
	return file;
}

function paths(matches: FileSearchMatch[]) {
	return [...new Set(matches.map(match => match.path))].sort();
}

describe("searchFiles", () => {
	it("returns every occurrence in UTF-16 and preserves whitespace and CRLF line numbers", async () => {
		await write("unicode.txt", "😀é é  \r\nneedle needle\n");
		const result = await searchFiles({ path: root, pattern: "é|needle" });
		expect(result).toMatchObject({ totalMatches: 4, filesWithMatches: 1, filesSearched: 1 });
		expect(result.matches).toEqual([
			{
				path: "unicode.txt",
				lineNumber: 1,
				line: "😀é é  ",
				ranges: [
					{ start: 2, length: 1 },
					{ start: 4, length: 1 },
				],
			},
			{
				path: "unicode.txt",
				lineNumber: 2,
				line: "needle needle",
				ranges: [
					{ start: 0, length: 6 },
					{ start: 7, length: 6 },
				],
			},
		]);
	});

	it("matches CRLF anchors before removing carriage returns from displayed lines", async () => {
		await write("lines.txt", "needle\r\nneedle\n");
		const unix = await searchFiles({ path: root, pattern: "needle$" });
		expect(unix.totalMatches).toBe(1);
		expect(unix.matches[0]).toMatchObject({ lineNumber: 2, line: "needle" });
		const both = await searchFiles({ path: root, pattern: "needle\\r?$" });
		expect(both.totalMatches).toBe(2);
		expect(both.matches.map(match => match.lineNumber)).toEqual([1, 2]);
	});

	it("keeps rg zero-width iteration, including byte boundaries inside Unicode", async () => {
		const file = await write("zero.txt", "é😀\n\n");
		const result = await searchFiles({ path: file, pattern: "" });
		expect(result.totalMatches).toBe(8);
		expect(result.matches[0].ranges).toEqual([0, 1, 1, 2, 2, 2, 3].map(start => ({ start, length: 0 })));
		expect(result.matches[1]).toMatchObject({ lineNumber: 2, line: "", ranges: [{ start: 0, length: 0 }] });
		await Bun.write(file, "aab\n");
		const adjacent = await searchFiles({ path: file, pattern: "a*" });
		expect(adjacent.totalMatches).toBe(2);
		expect(adjacent.matches[0].ranges).toEqual([
			{ start: 0, length: 2 },
			{ start: 3, length: 0 },
		]);
	});

	it("applies literal, case and real word flags without changing agent grep", async () => {
		const file = await write("literal.txt", "hello( hello( HELLO( xhello( hello(x\n-2 a-2 -2a\n");
		const literal = await searchFiles({ path: file, pattern: "hello(", fixedStrings: true });
		expect(literal.totalMatches).toBe(4);
		const words = await searchFiles({
			path: file,
			pattern: "hello(",
			fixedStrings: true,
			wholeWord: true,
			ignoreCase: true,
		});
		expect(words.totalMatches).toBe(3);
		const punctuation = await searchFiles({ path: file, pattern: "-2", fixedStrings: true, wholeWord: true });
		expect(punctuation.matches[0].ranges).toEqual([{ start: 0, length: 2 }]);
		expect((await grep({ path: file, pattern: "hello(" })).totalMatches).toBe(1);
	});

	it("rejects invalid and unsupported regex instead of applying agent repairs", async () => {
		await write("syntax.txt", "hello( aa\n");
		for (const pattern of ["hello(", "[", "(?=a)", "(a)\\1", "a\\nb"]) {
			await expect(searchFiles({ path: root, pattern })).rejects.toThrow("Regex error");
		}
		await expect(searchFiles({ path: root, pattern: "needle", includeGlobs: ["["] })).rejects.toThrow("glob");
	});

	it("searches tails of large directory files and lines spanning read windows", async () => {
		await write("large.txt", `${"x\n".repeat(2 * 1024 * 1024 + 10)}needle needle\n`);
		await write("long.txt", `${"x".repeat(4 * 1024 * 1024 + 3)}needle\n`);
		const result = await searchFiles({ path: root, pattern: "needle" });
		expect(result.totalMatches).toBe(3);
		expect(result.filesWithMatches).toBe(2);
		expect(result.matches[0]).toMatchObject({ path: "large.txt", lineNumber: 2 * 1024 * 1024 + 11 });
		expect(result.matches[1].ranges).toEqual([{ start: 4 * 1024 * 1024 + 3, length: 6 }]);
	});

	it("keeps hidden out, applies .ignore everywhere and .gitignore only in repositories", async () => {
		await write(".gitignore", "ignored.txt\n");
		await write(".ignore", "excluded.txt\n");
		await write("ignored.txt");
		await write("excluded.txt");
		await write("plain.txt");
		await write(".hidden.txt");
		await write(".hidden/nested.txt");
		await write("node_modules/pkg/unignored.txt");
		const outside = await searchFiles({ path: root, pattern: "needle" });
		expect(paths(outside.matches)).toEqual(["ignored.txt", "node_modules/pkg/unignored.txt", "plain.txt"]);
		await fs.mkdir(path.join(root, ".git"));
		const inside = await searchFiles({ path: root, pattern: "needle" });
		expect(paths(inside.matches)).toEqual(["node_modules/pkg/unignored.txt", "plain.txt"]);
	});

	it("uses multiple rg override globs with excludes last and no recursive slash rewrite", async () => {
		await fs.mkdir(path.join(root, ".git"));
		await write(".gitignore", "ignored.txt\n");
		await write(".ignore", "*.md\n");
		for (const name of [
			"ignored.txt",
			".hidden.txt",
			"keep.md",
			"drop.md",
			"omit.test.txt",
			"src/direct.txt",
			"src/deep/nested.txt",
			"nested/keep.md",
		]) {
			await write(name);
		}
		const overrides = await searchFiles({
			path: root,
			pattern: "needle",
			includeGlobs: ["*.txt", "*.md"],
			excludeGlobs: ["*.test.txt", "drop.md"],
		});
		expect(paths(overrides.matches)).toEqual([
			".hidden.txt",
			"ignored.txt",
			"keep.md",
			"nested/keep.md",
			"src/deep/nested.txt",
			"src/direct.txt",
		]);
		const scoped = await searchFiles({
			path: root,
			pattern: "needle",
			includeGlobs: ["src/*.txt", "*.md"],
			excludeGlobs: ["drop.md"],
		});
		expect(paths(scoped.matches)).toEqual(["keep.md", "nested/keep.md", "src/direct.txt"]);
		await write(".git/explicit.txt");
		const git = await searchFiles({ path: root, pattern: "needle", includeGlobs: ["**"] });
		expect(paths(git.matches)).toContain(".git/explicit.txt");
	});

	it("does not enter ignored or hidden directories solely because child files match a glob", async () => {
		await fs.mkdir(path.join(root, ".git"));
		await write(".gitignore", "ignored/\n");
		await write("ignored/one.txt");
		await write(".hidden/two.txt");
		await write("plain.txt");
		const result = await searchFiles({ path: root, pattern: "needle", includeGlobs: ["*.txt"] });
		expect(paths(result.matches)).toEqual(["plain.txt"]);
		const explicit = await searchFiles({ path: root, pattern: "needle", includeGlobs: ["**"] });
		expect(paths(explicit.matches)).toEqual([".hidden/two.txt", "ignored/one.txt", "plain.txt"]);
	});

	it("keeps ignore-file whitelist precedence and ancestor .ignore outside repositories", async () => {
		await write(".ignore", "*.txt\n!keep.txt\n!.visible.txt\n");
		await write("keep.txt");
		await write(".visible.txt");
		await write("drop.txt");
		const result = await searchFiles({ path: root, pattern: "needle" });
		expect(paths(result.matches)).toEqual([".visible.txt", "keep.txt"]);
		await write("child/drop.txt");
		await write("child/keep.txt");
		const child = await searchFiles({ path: path.join(root, "child"), pattern: "needle" });
		expect(paths(child.matches)).toEqual(["keep.txt"]);
	});

	it("honors .rgignore above .ignore without changing the agent's ignore policy", async () => {
		await write(".ignore", "keep.txt\n!drop.txt\n");
		await write(".rgignore", "!keep.txt\ndrop.txt\n");
		await write("keep.txt");
		await write("drop.txt");
		const strict = await searchFiles({ path: root, pattern: "needle" });
		expect(paths(strict.matches)).toEqual(["keep.txt"]);
		const agent = await grep({ path: root, pattern: "needle" });
		expect(agent.matches.map(match => match.path)).toEqual(["drop.txt"]);
	});

	it("stops ancestor git rules at a nested repository, while retaining .ignore rules", async () => {
		await fs.mkdir(path.join(root, ".git"));
		await write(".gitignore", "*.txt\n");
		await write(".ignore", "drop.md\n");
		await write("nested/.git/info/exclude", "excluded.txt\n");
		await write("nested/keep.txt");
		await write("nested/excluded.txt");
		await write("nested/drop.md");
		const result = await searchFiles({ path: path.join(root, "nested"), pattern: "needle" });
		expect(paths(result.matches)).toEqual(["keep.txt"]);
	});

	it("streams during scanning in bounded batches and waits for callbacks", async () => {
		await write("dense.txt", "needle needle\n".repeat(3000));
		const batches: number[] = [];
		let count = 0;
		let complete = false;
		const result = await searchFiles({
			path: root,
			pattern: "needle",
			onMatches: matches => {
				expect(complete).toBeFalse();
				batches.push(matches.length);
				count += matches.reduce((sum, match) => sum + match.ranges.length, 0);
			},
		});
		complete = true;
		expect(batches.length).toBeGreaterThan(1);
		expect(batches.every(size => size > 0 && size <= 1024)).toBeTrue();
		expect(count).toBe(6000);
		expect(result).toMatchObject({ matches: [], totalMatches: 6000, filesWithMatches: 1, filesSearched: 1 });
	});

	it("reserves the global occurrence cap before allocating a huge line's ranges", async () => {
		await write("hot.txt", "x".repeat(2_000_000));
		const result = await searchFiles({ path: root, pattern: "x", maxMatches: 101 });
		expect(result).toMatchObject({ totalMatches: 101, filesWithMatches: 1, limitReached: true });
		expect(result.matches[0].ranges.length).toBe(101);
		const zero = await searchFiles({ path: root, pattern: "x", maxMatches: 0 });
		expect(zero).toMatchObject({ matches: [], totalMatches: 0, filesSearched: 0, limitReached: true });
		await write("second.txt", "x".repeat(1000));
		let streamed = 0;
		const capped = await searchFiles({
			path: root,
			pattern: "x",
			maxMatches: 1001,
			onMatches: matches => {
				streamed += matches.reduce((sum, match) => sum + match.ranges.length, 0);
			},
		});
		expect(streamed).toBe(1001);
		expect(capped).toMatchObject({ matches: [], totalMatches: 1001, limitReached: true });
	});

	it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
		"reports unreadable files and directories while keeping delivered partial results",
		async () => {
			const file = await write("unreadable.txt");
			await fs.chmod(file, 0);
			try {
				await expect(searchFiles({ path: root, pattern: "needle" })).rejects.toThrow("unreadable.txt");
			} finally {
				await fs.chmod(file, 0o600);
			}
			await fs.rm(file);
			await write("locked/secret.txt");
			await write("visible.txt");
			const directory = path.join(root, "locked");
			await fs.chmod(directory, 0);
			const delivered: FileSearchMatch[] = [];
			try {
				await expect(
					searchFiles({ path: root, pattern: "needle", onMatches: matches => delivered.push(...matches) }),
				).rejects.toThrow("locked");
				expect(paths(delivered)).toEqual(["visible.txt"]);
			} finally {
				await fs.chmod(directory, 0o700);
			}
		},
	);

	it("rejects callback exceptions, aborts and timeouts after any delivered partial batches", async () => {
		await write("dense.txt", "needle\n".repeat(100_000));
		await expect(
			searchFiles({
				path: root,
				pattern: "needle",
				onMatches: () => {
					throw new Error("consumer failed");
				},
			}),
		).rejects.toThrow("consumer failed");
		const controller = new AbortController();
		let delivered = 0;
		await expect(
			searchFiles({
				path: root,
				pattern: "needle",
				signal: controller.signal,
				onMatches: matches => {
					delivered += matches.length;
					controller.abort();
				},
			}),
		).rejects.toThrow("Aborted");
		expect(delivered).toBeGreaterThan(0);
		const alreadyAborted = new AbortController();
		alreadyAborted.abort();
		await expect(searchFiles({ path: root, pattern: "needle", signal: alreadyAborted.signal })).rejects.toThrow(
			"Aborted",
		);
		await expect(searchFiles({ path: root, pattern: "needle", timeoutMs: 0 })).rejects.toThrow("Timeout");
	});
});
