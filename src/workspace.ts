import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const WALK_SKIP = new Set([".git", "node_modules", "dist", "build", ".next", "coverage", ".turbo", ".cache"]);
const HARD_FILE_LIMIT = 5_000_000;

// Untracked files that are AI-tool state or backups, not code under review.
const TOOL_STATE_RE = /^(\.agents|\.codex|\.claude|\.cline|\.cursor|\.idea|\.vscode|\.continue)\/|(\.bak|-bak|~)$/;

/** Tracks how much tool output a model has consumed during one task. */
export class Budget {
  used = 0;
  constructor(public limit: number, public perRead: number) {}
  get left() {
    return Math.max(0, this.limit - this.used);
  }
  /** Charge text against the budget, truncating to what's left. */
  spend(text: string): string {
    if (this.left <= 0) {
      return "READ BUDGET EXHAUSTED. Do not call more tools. Answer now in the required format.";
    }
    const out = text.length > this.left ? `${text.slice(0, this.left)}\n[TRUNCATED: read budget reached]` : text;
    this.used += Math.min(text.length, this.left);
    return out;
  }
}

export class Workspace {
  private fileCache: { at: number; files: string[] } | null = null;

  private constructor(public readonly root: string) {}

  static async open(dir: string): Promise<Workspace> {
    const root = await fs.realpath(dir);
    const st = await fs.stat(root);
    if (!st.isDirectory()) throw new Error(`Workspace is not a directory: ${dir}`);
    return new Workspace(root);
  }

  /** Resolve a path and refuse anything outside the workspace (symlinks included). */
  async resolve(p: string): Promise<string> {
    const candidate = path.isAbsolute(p) ? path.resolve(p) : path.resolve(this.root, p);
    let real: string;
    try {
      real = await fs.realpath(candidate);
    } catch (e: any) {
      if (e?.code === "ENOENT") throw new Error(`File not found: ${p}`);
      throw e;
    }
    const rel = path.relative(this.root, real);
    if (rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
      throw new Error(`Path escapes workspace: ${p}`);
    }
    return real;
  }

  rel(abs: string): string {
    return path.relative(this.root, abs) || ".";
  }

  async isGitRepo(): Promise<boolean> {
    try {
      await execFileAsync("git", ["rev-parse", "--is-inside-work-tree"], { cwd: this.root });
      return true;
    } catch {
      return false;
    }
  }

  /** All files (git-aware when possible, so .gitignore is respected). Cached briefly. */
  async listFiles(): Promise<string[]> {
    if (this.fileCache && Date.now() - this.fileCache.at < 10_000) return this.fileCache.files;
    let files: string[] = [];
    if (await this.isGitRepo()) {
      const { stdout } = await execFileAsync("git", ["ls-files", "-co", "--exclude-standard"], {
        cwd: this.root,
        maxBuffer: 100_000_000,
      });
      files = stdout.split("\n").filter(Boolean);
    } else {
      const walk = async (dir: string) => {
        const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
        await Promise.all(
          entries.map(async (e) => {
            if (WALK_SKIP.has(e.name)) return;
            const full = path.join(dir, e.name);
            if (e.isDirectory()) return walk(full);
            if (e.isFile()) files.push(path.relative(this.root, full));
          })
        );
      };
      await walk(this.root);
    }
    files.sort();
    this.fileCache = { at: Date.now(), files };
    return files;
  }

  async readFile(p: string, opts: { startLine?: number; endLine?: number; maxChars: number }): Promise<string> {
    const real = await this.resolve(p);
    const st = await fs.stat(real);
    if (!st.isFile()) throw new Error(`Not a file: ${p}`);
    if (st.size > HARD_FILE_LIMIT) throw new Error(`File too large (${st.size} bytes): ${p}. Search it instead.`);

    const lines = (await fs.readFile(real, "utf8")).split(/\r?\n/);
    const start = Math.max(1, opts.startLine ?? 1);
    const end = Math.min(lines.length, opts.endLine ?? lines.length);

    const out: string[] = [];
    let size = 0;
    let last = start - 1;
    for (let n = start; n <= end; n++) {
      const line = `${n} | ${lines[n - 1]}`;
      if (size + line.length + 1 > opts.maxChars && out.length) break;
      out.push(line);
      size += line.length + 1;
      last = n;
    }
    let text = out.join("\n");
    if (last < end) {
      text += `\n\n[TRUNCATED: showed lines ${start}-${last} of ${lines.length}. Request startLine/endLine for a specific section, or search for the symbol.]`;
    }
    return text;
  }

  async search(pattern: string, sub = ".", maxPerFile = 5): Promise<string> {
    const dir = sub === "." ? this.root : await this.resolve(sub);
    const rel = path.relative(this.root, dir) || ".";
    const n = String(Math.min(Math.max(1, maxPerFile), 20));
    const attempts: [string, string[]][] = [
      ["rg", ["-n", "--no-heading", "-S", "-m", n, "--max-columns", "300", "-g", "!node_modules", "-g", "!.git", "-e", pattern, rel]],
      ["grep", ["-rnIE", "-m", n, "--exclude-dir=node_modules", "--exclude-dir=.git", "-e", pattern, rel]],
    ];
    for (const [bin, args] of attempts) {
      try {
        return (await execFileAsync(bin, args, { cwd: this.root, maxBuffer: 20_000_000 })).stdout;
      } catch (e: any) {
        if (e?.code === "ENOENT") continue; // not installed, try the next tool
        if (e?.code === 1) return ""; // exit 1 = no matches
        if (e?.stdout) return e.stdout;
        throw new Error(`${bin} failed: ${e?.stderr || e?.message}`);
      }
    }
    throw new Error("Neither ripgrep nor grep is available.");
  }

  /**
   * Working-tree changes vs `base` (default HEAD), including staged changes,
   * plus untracked files shown as new files. Returns "" when nothing changed.
   */
  async diff(
    base = "HEAD",
    paths: string[] = [],
    opts: { includeUntracked?: boolean; maxUntrackedChars?: number } = {}
  ): Promise<{ diff: string; files: string[]; skippedUntracked: string[] }> {
    const includeUntracked = opts.includeUntracked ?? true;
    const maxUntrackedChars = opts.maxUntrackedChars ?? 20_000;
    if (!(await this.isGitRepo())) throw new Error("Workspace is not a git repository; nothing to diff.");
    if (!/^[\w./~^@{}:-]+$/.test(base)) throw new Error(`Invalid base ref: ${base}`);
    for (const p of paths) await this.resolve(p).catch(() => undefined); // containment check only

    const scope = paths.length ? ["--", ...paths] : [];
    const { stdout: tracked } = await execFileAsync("git", ["diff", "--no-color", "-U5", base, ...scope], {
      cwd: this.root,
      maxBuffer: 100_000_000,
    });
    const { stdout: names } = await execFileAsync("git", ["diff", "--name-only", base, ...scope], { cwd: this.root });
    const { stdout: untrackedList } = await execFileAsync(
      "git",
      ["ls-files", "--others", "--exclude-standard", ...scope],
      { cwd: this.root }
    );

    const files = names.split("\n").filter(Boolean);
    let diff = tracked;
    const skippedUntracked: string[] = [];
    for (const f of untrackedList.split("\n").filter(Boolean)) {
      // AI tool state and backups aren't part of the change under review.
      if (!includeUntracked || TOOL_STATE_RE.test(f)) {
        skippedUntracked.push(f);
        continue;
      }
      files.push(f);
      try {
        const body = await fs.readFile(await this.resolve(f), "utf8");
        const clipped = body.length > maxUntrackedChars ? body.slice(0, maxUntrackedChars) + "\n[TRUNCATED]" : body;
        diff += `\ndiff --git a/${f} b/${f}\nnew file (untracked)\n--- /dev/null\n+++ b/${f}\n${clipped
          .split("\n")
          .map((l) => `+${l}`)
          .join("\n")}\n`;
      } catch {
        // unreadable or binary: list it without content
      }
    }
    return { diff, files, skippedUntracked };
  }
}
