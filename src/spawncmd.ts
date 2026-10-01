import fs from "node:fs";
import path from "node:path";

/** What to actually spawn for a command: on Windows that differs from what was asked for. */
export interface Launch {
  command: string;
  args: string[];
  /** Set for cmd.exe: the command line is already quoted, so Node must not quote it again. */
  windowsVerbatimArguments?: boolean;
}

export interface LaunchEnv {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  exists: (file: string) => boolean;
  /** Text of a file, or null if it can't be read (used to look inside npm's .cmd shims). */
  read: (file: string) => string | null;
  execPath: string;
}

const readText = (f: string) => {
  try {
    return fs.readFileSync(f, "utf8");
  } catch {
    return null;
  }
};
const defaults = (): LaunchEnv => ({ platform: process.platform, env: process.env, exists: fs.existsSync, read: readText, execPath: process.execPath });

/** A Windows environment variable, whatever case its name was set in. */
const winEnv = (env: NodeJS.ProcessEnv, name: string) => env[Object.keys(env).find((k) => k.toUpperCase() === name) ?? name];

/**
 * The script a plain npm-generated .cmd shim (cmd-shim) runs, so it can run under Node directly and its arguments
 * never pass through cmd.exe. Only the exact launch line counts: `"%_prog%" "%dp0%\<script>.js" %*` (or the older
 * `"%~dp0\node.exe" "%~dp0\<script>.js" %*` / `node "%~dp0\<script>.js" %*`), with no interpreter flags, on the one
 * line that forwards `%*`. A shim that sets NODE_PATH or NODE_OPTIONS (pnpm) isn't plain: null, so it runs as written.
 */
export function npmShimTarget(shimFile: string, text: string | null): string | null {
  const t = text || "";
  if (/NODE_PATH|NODE_OPTIONS/i.test(t)) return null;
  const launch = t.split(/\r?\n/).map((l) => l.trim()).filter((l) => /%\*$/.test(l));
  if (launch.length !== 1) return null;
  const m = /(?:^|[&|]\s*)@?(?:"%_prog%"|"%~dp0\\?node(?:\.exe)?"|node)\s+"%~?dp0%?\\?([^"%]+\.[cm]?js)"\s+%\*$/i.exec(launch[0]);
  return m ? path.win32.join(path.win32.dirname(shimFile), m[1]) : null;
}

// Windows command-line quoting, ported from cross-spawn (lib/util/escape.js, MIT, © 2018 Made With MOXY Lda).
// Arguments are quoted for CreateProcess, then cmd.exe's metacharacters are escaped with ^ so that nothing in
// them (a workspace path, a model name) is interpreted by the shell.
const META = /([()\][%!^"`<>&|;, *?])/g;
const escapeCommand = (s: string) => s.replace(META, "^$1");
function escapeArgument(arg: string, doubleEscape: boolean): string {
  let s = `${arg}`;
  s = s.replace(/(?=(\\+?)?)\1"/g, '$1$1\\"'); // backslashes before a quote are doubled, the quote escaped
  s = s.replace(/(?=(\\+?)?)\1$/, "$1$1"); // trailing backslashes are doubled (they precede the closing quote)
  s = `"${s}"`;
  s = s.replace(META, "^$1");
  if (doubleEscape) s = s.replace(META, "^$1"); // npm's node_modules/.bin shims pass arguments through cmd twice
  return s;
}

/** Find a bare command on PATH the way Windows does, trying each PATHEXT extension. Null if it isn't there. */
function whichWindows(cmd: string, e: LaunchEnv): string | null {
  const exts = (winEnv(e.env, "PATHEXT") || ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean);
  const hasDir = /[\\/]/.test(cmd);
  const dirs = hasDir ? [""] : (winEnv(e.env, "PATH") || "").split(";").map((d) => d.replace(/^"(.*)"$/, "$1")).filter(Boolean);
  const hasExt = path.win32.extname(cmd) !== "";
  for (const dir of dirs) {
    const base = dir ? path.win32.join(dir, cmd) : cmd;
    if (hasExt && e.exists(base)) return base;
    for (const ext of exts.map((x) => x.toLowerCase())) if (e.exists(base + ext)) return base + ext; // Windows paths ignore case
  }
  return null;
}

/**
 * How to spawn `cmd args` without a shell. Linux and macOS: exactly as given. Windows:
 * - a bare name is looked up on PATH with PATHEXT (an explicit path without an extension tries PATHEXT too);
 * - a `.js`/`.mjs`/`.cjs` script runs under this Node (Windows can't run a script by its shebang);
 * - a plain npm `.cmd` shim (how npm installs CLIs such as `codex`) runs its script under the `node.exe` next to the
 *   shim if there is one, else under this Node, as the shim itself would; arguments never pass through cmd.exe;
 * - any other `.cmd`/`.bat` runs through `cmd.exe /d /s /c` with every argument quoted and escaped (cross-spawn's
 *   rules). An argument with a line break is refused there, since cmd would end the command at it; a `%` can still
 *   expand inside the batch file;
 * - anything else is spawned as given, so a missing command still fails with ENOENT.
 */
export function launchSpec(cmd: string, args: string[], over: Partial<LaunchEnv> = {}): Launch {
  const e = { ...defaults(), ...over };
  if (e.platform !== "win32") return { command: cmd, args };
  if (/\.[cm]?js$/i.test(cmd)) return { command: e.execPath, args: [cmd, ...args] };
  const file = whichWindows(cmd, e);
  if (!file) return { command: cmd, args };
  if (/\.[cm]?js$/i.test(file)) return { command: e.execPath, args: [file, ...args] };
  if (!/\.(cmd|bat)$/i.test(file)) return { command: file, args };
  const script = npmShimTarget(file, e.read(file));
  if (script && e.exists(script)) {
    const bundled = path.win32.join(path.win32.dirname(file), "node.exe");
    return { command: e.exists(bundled) ? bundled : e.execPath, args: [script, ...args] };
  }
  const broken = args.find((a) => /[\r\n]/.test(a));
  if (broken !== undefined) throw new Error(`refusing to pass an argument with a line break through cmd.exe to ${file}: ${JSON.stringify(broken.slice(0, 80))}`);
  const doubleEscape = /node_modules[\\/]\.bin[\\/][^\\/]+\.cmd$/i.test(file);
  const line = [escapeCommand(path.win32.normalize(file)), ...args.map((a) => escapeArgument(a, doubleEscape))].join(" ");
  return { command: winEnv(e.env, "COMSPEC") || "cmd.exe", args: ["/d", "/s", "/c", `"${line}"`], windowsVerbatimArguments: true };
}
