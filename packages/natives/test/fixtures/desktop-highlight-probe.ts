import assert from "node:assert/strict";
import * as native from "../../native/index.js";
import { loadNative } from "../../native/loader-state.js";
import {
	createHighlightStream,
	getMarkdownTheme,
	getSelectListTheme,
	highlightCode,
	warmHighlighter,
} from "../../../tui/src/theme/theme";

// The full JS manifest must load against the actual cut addon. Missing TUI
// syntax highlighting is an operation error, never an addon-import failure.
assert.equal(native.nativeCapabilities().syntaxHighlighting, false);
const raw = loadNative();
for (const name of [
	"highlightCode",
	"warmHighlighter",
	"HighlightStream",
	"supportsLanguage",
	"getSupportedLanguages",
]) {
	assert.equal(name in raw, false, name);
}
const unavailable = /syntaxHighlighting.*unavailable/;
const colors = {
	comment: "<c>",
	keyword: "<k>",
	function: "<f>",
	variable: "<v>",
	string: "<s>",
	number: "<n>",
	type: "<t>",
	operator: "<o>",
	punctuation: "<p>",
};
assert.throws(() => native.highlightCode("const value = 1;", "javascript", colors), unavailable);
assert.throws(() => native.supportsLanguage("javascript"), unavailable);
assert.throws(() => native.getSupportedLanguages(), unavailable);
assert.throws(() => native.warmHighlighter(), unavailable);
assert.equal(native.HighlightStream, undefined);
assert.throws(() => highlightCode("const value = 1;", "javascript"), unavailable);
assert.throws(() => highlightCode("plain text"), unavailable);
assert.throws(() => createHighlightStream("javascript"), unavailable);
assert.throws(() => warmHighlighter(), unavailable);
const markdown = getMarkdownTheme();
assert.throws(() => markdown.highlightCode?.("const value = 1;", "javascript"), unavailable);
assert.throws(() => markdown.createHighlightStream?.("javascript"), unavailable);
assert.equal(typeof getSelectListTheme().selectedText("ready"), "string");

// Editing's real grammar and parser remain independent of syntect.
const ast = await native.astMatch({
	source: 'function greet() { console.log("hi"); }',
	lang: "ts",
	patterns: ["console.log($MSG)"],
});
assert.equal(ast.totalMatches, 1);
assert.equal(ast.matches[0]?.text, 'console.log("hi")');
const incomplete = await native.astMatch({ source: "console.log(", lang: "ts", patterns: ["console.log($A)"] });
assert.ok((incomplete.parseErrors?.length ?? 0) > 0);
assert.equal(native.countTokens("hello world", native.Encoding.O200kBase), 2);
console.log("desktop highlighting boundary ok");
