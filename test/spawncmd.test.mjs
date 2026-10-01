// Unit tests for launchSpec: how crew spawns the Codex CLI on each platform. Windows is simulated (platform, PATH,
// PATHEXT and the filesystem are injected), so these run anywhere; e2e.test.mjs drives a real .cmd shim on Windows.
import { test } from "node:test";
import assert from "node:assert/strict";
import { launchSpec, npmShimTarget } from "../dist/spawncmd.js";

// files: paths that exist; shims: { path: text } for .cmd files whose content launchSpec may read.
const win = (files, env = {}, shims = {}) => ({
  platform: "win32",
  execPath: "C:\\node\\node.exe",
  exists: (f) => [...files, ...Object.keys(shims)].some((x) => x.toLowerCase() === f.toLowerCase()), // NTFS ignores case
  read: (f) => shims[f] ?? "@echo off\r\nrem a hand-written wrapper\r\nsome-tool %*\r\n",
  env: { PATH: "C:\\Windows\\system32;C:\\Tools\\npm global", PATHEXT: ".COM;.EXE;.BAT;.CMD", ComSpec: "C:\\Windows\\system32\\cmd.exe", ...env },
});
const SHIM = "C:\\Tools\\npm global\\codex.cmd";

test("POSIX: everything is spawned exactly as given, scripts included (their shebang runs them)", () => {
  const linux = { platform: "linux", execPath: "/usr/bin/node", exists: () => true, read: () => null, env: {} };
  assert.deepEqual(launchSpec("codex", ["exec", "-"], linux), { command: "codex", args: ["exec", "-"] });
  assert.deepEqual(launchSpec("/opt/fake-codex.mjs", ["--version"], linux), { command: "/opt/fake-codex.mjs", args: ["--version"] });
  assert.deepEqual(launchSpec("codex", ["a\nb"], linux).args, ["a\nb"], "no shell, so nothing to refuse");
});

// What npm (cmd-shim) writes for a global install of @openai/codex.
const NPM_SHIM = [
  "@ECHO off", "GOTO start", ":find_dp0", "SET dp0=%~dp0", "EXIT /b", ":start", "SETLOCAL", "CALL :find_dp0", "",
  'IF EXIST "%dp0%\\node.exe" (', '  SET "_prog=%dp0%\\node.exe"', ") ELSE (", '  SET "_prog=node"', "  SET PATHEXT=%PATHEXT:;.JS;=;%", ")", "",
  'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@openai\\codex\\bin\\codex.js" %*',
].join("\r\n");
const SCRIPT = "C:\\Tools\\npm global\\node_modules\\@openai\\codex\\bin\\codex.js";

test("Windows: an npm .cmd shim runs its script under Node directly, so arguments never pass through cmd.exe", () => {
  const args = ["exec", "-C", "C:\\work\\my repo", "-m", 'gpt-5 & del x %PATH% "q"', "-"];
  assert.deepEqual(launchSpec("codex", args, win([SCRIPT], {}, { [SHIM]: NPM_SHIM })), { command: "C:\\node\\node.exe", args: [SCRIPT, ...args] });
  assert.equal(npmShimTarget(SHIM, NPM_SHIM), SCRIPT);
  assert.equal(npmShimTarget("C:\\x\\old.cmd", '@"%~dp0\\node.exe" "%~dp0\\node_modules\\old\\cli.js" %*'), "C:\\x\\node_modules\\old\\cli.js", "older cmd-shim format");
  assert.equal(npmShimTarget(SHIM, "@echo off\r\nsome-tool %*"), null);
  // A shim whose script is gone falls back to cmd.exe rather than running a missing file.
  assert.equal(launchSpec("codex", ["-"], win([], {}, { [SHIM]: NPM_SHIM })).windowsVerbatimArguments, true);
  // The node.exe npm may place next to the shim wins, as in the shim's own IF EXIST branch.
  const bundled = "C:\\Tools\\npm global\\node.exe";
  assert.equal(launchSpec("codex", [], win([SCRIPT, bundled], {}, { [SHIM]: NPM_SHIM })).command, bundled);
});

test("Windows: only a plain shim launch line is bypassed; anything else goes through cmd.exe as written", () => {
  const fallback = (text) => npmShimTarget(SHIM, text);
  assert.equal(fallback('@SET NODE_PATH=%~dp0\\..\\lib\r\n"%_prog%" "%dp0%\\x\\cli.js" %*'), null, "pnpm sets NODE_PATH");
  assert.equal(fallback('& "%_prog%" --experimental-foo "%dp0%\\x\\cli.js" %*'), null, "interpreter flags would be lost");
  assert.equal(fallback('rem "%dp0%\\decoy.js" %*\r\n& "%_prog%" "%dp0%\\x\\cli.js" %*'), null, "two lines forward %*: not a plain shim");
  assert.equal(fallback('& "%_prog%" "%dp0%\\x\\cli.js" %* & del everything'), null, "the launch must end the line");
  assert.equal(fallback('@"%~dp0\\node.exe" "%~dp0\\..\\x\\cli.js" %*'), "C:\\Tools\\x\\cli.js");
});

test("Windows: an argument with a line break is refused rather than passed through cmd.exe", () => {
  assert.throws(() => launchSpec("codex", ["-m", "gpt\r\ndel x"], win([SHIM])), /refusing to pass an argument with a line break through cmd\.exe/);
  assert.deepEqual(launchSpec("codex", ["a\nb"], win([SCRIPT], {}, { [SHIM]: NPM_SHIM })).args, [SCRIPT, "a\nb"], "fine when cmd.exe isn't involved");
});

test("Windows: a quoted PATH entry is searched without its quotes", () => {
  assert.equal(launchSpec("codex", [], win([SHIM], { PATH: '"C:\\Tools\\npm global";C:\\x' })).windowsVerbatimArguments, true);
});

test("Windows: PATH, PATHEXT and ComSpec are found whatever case their names were set in", () => {
  const env = { path: "C:\\Tools\\npm global", pathext: ".CMD", comspec: "C:\\cmd\\cmd.exe" };
  const l = launchSpec("codex", [], { ...win([SHIM]), env });
  assert.equal(l.command, "C:\\cmd\\cmd.exe");
});

test("Windows: any other .cmd found on PATH runs through cmd.exe, every argument quoted and ^-escaped", () => {
  const l = launchSpec("codex", ["exec", "-C", "C:\\work\\my repo", "-m", "gpt-5 & del x", "-"], win([SHIM]));
  assert.equal(l.command, "C:\\Windows\\system32\\cmd.exe");
  assert.equal(l.windowsVerbatimArguments, true);
  assert.deepEqual(l.args.slice(0, 3), ["/d", "/s", "/c"]);
  assert.equal(
    l.args[3],
    '"C:\\Tools\\npm^ global\\codex.cmd ^"exec^" ^"-C^" ^"C:\\work\\my^ repo^" ^"-m^" ^"gpt-5^ ^&^ del^ x^" ^"-^""',
    "spaces and & can't split or chain the command",
  );
});

test("Windows: quotes inside an argument and trailing backslashes survive CreateProcess parsing", () => {
  const line = launchSpec("codex", ['say "hi"', "C:\\out dir\\"], win([SHIM])).args[3];
  assert.ok(line.includes('^"say^ \\^"hi\\^"^"'), line); // "say \"hi\""
  assert.ok(line.includes('^"C:\\out^ dir\\\\^"'), line); // "C:\out dir\\" so the closing quote isn't escaped
});

test("Windows: a shim under node_modules/.bin is escaped twice, as npm's shims re-parse their arguments", () => {
  const local = "C:\\proj\\node_modules\\.bin\\codex.cmd";
  const line = launchSpec(local, ["a b"], win([local])).args[3];
  assert.ok(line.endsWith('^^^"a^^^ b^^^""'), line);
});

test("Windows: PATHEXT order decides between codex.exe and codex.cmd; an .exe is spawned directly", () => {
  const exe = "C:\\Tools\\npm global\\codex.exe";
  assert.deepEqual(launchSpec("codex", ["--version"], win([SHIM, exe])), { command: exe, args: ["--version"] });
  assert.equal(launchSpec("codex", ["--version"], win([SHIM, exe], { PATHEXT: ".CMD;.EXE" })).windowsVerbatimArguments, true);
});

test("Windows: an explicit path is used as is; a script path runs under Node; nothing found stays as asked (ENOENT)", () => {
  const explicit = "D:\\Program Files\\codex\\codex.cmd";
  assert.match(launchSpec(explicit, [], win([explicit])).args[3], /^"D:\\Program\^ Files\\codex\\codex\.cmd"$/);
  assert.deepEqual(launchSpec("C:\\t\\fake-codex.mjs", ["-"], win([])), { command: "C:\\node\\node.exe", args: ["C:\\t\\fake-codex.mjs", "-"] });
  assert.deepEqual(launchSpec("codex", ["--version"], win([])), { command: "codex", args: ["--version"] }, "so spawn reports ENOENT and crew says to install it");
  assert.equal(launchSpec("codex", [], win([SHIM], { ComSpec: undefined })).command, "cmd.exe");
});
