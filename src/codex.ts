import { spawn } from "node:child_process";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { WorkerConfig } from "./config.js";
import { launchSpec } from "./spawncmd.js";

/**
 * Runs `codex exec` non-interactively in a READ-ONLY sandbox rooted at the
 * workspace. Uses whatever auth Codex has (e.g. `codex login` with a ChatGPT
 * plan), so no API key is needed. Codex explores the repo with its own tools.
 */
export async function runCodex(opts: {
  w: WorkerConfig;
  cwd: string;
  prompt: string;
  timeoutMs: number;
  signal: AbortSignal;
}): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "crew-codex-"));
  const outFile = path.join(dir, "last-message.txt");
  const args = [
    "exec",
    "-s", "read-only",
    "-C", opts.cwd,
    "--skip-git-repo-check",
    "--ephemeral",
    "--color", "never",
    "-o", outFile,
  ];
  if (opts.w.model) args.push("-m", opts.w.model);
  args.push("-"); // prompt on stdin

  try {
    const { code, stdout, stderr } = await new Promise<{ code: number | null; stdout: string; stderr: string }>(
      (resolve, reject) => {
        // launchSpec: on Windows `codex` is an npm .cmd shim, which spawn can't run without cmd.exe.
        const l = launchSpec(opts.w.codexPath || "codex", args);
        const child = spawn(l.command, l.args, { cwd: opts.cwd, env: process.env, windowsVerbatimArguments: l.windowsVerbatimArguments });
        let stdout = "";
        let stderr = "";
        const kill = () => child.kill("SIGTERM");
        const timer = setTimeout(kill, opts.timeoutMs);
        opts.signal.addEventListener("abort", kill, { once: true });
        child.stdout.on("data", (d) => (stdout += d));
        child.stderr.on("data", (d) => (stderr += d));
        child.on("error", (e: any) =>
          reject(e?.code === "ENOENT" ? new Error("codex CLI not found. Install it and run `codex login`.") : e)
        );
        child.on("close", (code) => {
          clearTimeout(timer);
          resolve({ code, stdout, stderr });
        });
        child.stdin.end(opts.prompt);
      }
    );

    const last = await fs.readFile(outFile, "utf8").catch(() => "");
    if (last.trim()) return last.trim();
    if (code !== 0) throw new Error(`codex exited ${code}: ${(stderr || stdout).slice(-500)}`);
    return stdout.trim();
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

const VERSION_DIR = /^v?\d+\.\d+\.\d+$/;

/**
 * Codex installs under nvm's Node versions. nvm gives each Node version its own global packages, so
 * after a Node upgrade `codex` is still on disk but no longer on PATH. Newest version first.
 * (nvm-windows keeps versions in another layout, so this finds nothing there.)
 */
export function codexUnderNodeVersions(env: NodeJS.ProcessEnv = process.env): { version: string; file: string }[] {
  const root = path.join(env.NVM_DIR || path.join(os.homedir(), ".nvm"), "versions", "node");
  let versions: string[];
  try {
    versions = fsSync.readdirSync(root).filter((v) => VERSION_DIR.test(v));
  } catch {
    return [];
  }
  const num = (v: string) => v.replace(/^v/, "").split(".").map(Number);
  return versions
    .flatMap((version) => {
      const file = path.join(root, version, "bin", "codex");
      return fsSync.existsSync(file) ? [{ version, file }] : [];
    })
    .sort((a, b) => {
      const x = num(a.version), y = num(b.version);
      return y[0] - x[0] || y[1] - x[1] || y[2] - x[2];
    });
}
