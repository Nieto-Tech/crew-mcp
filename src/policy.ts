import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import type { WorkerConfig } from "./config.js";

/**
 * Per-repo policy, read from `.crew.json` at the workspace root.
 *   { "cloud": false }  → only local workers may run (no content leaves the machine).
 *   { "map": "docs/MAP.md" }  → the code map to show the scout (default docs/CODEMAP.md), relative to the workspace.
 * Enforced by crew itself, so it holds no matter what Claude asks for.
 */
export interface Policy {
  /** false = cloud workers are never used, and never fallen back to. */
  cloud: boolean;
  /** Code map path from .crew.json ("map"), when set. Relative to the workspace root. */
  map?: string;
  /** The file the policy came from, when there is one. */
  file?: string;
  /** Where the policy came from (for status output). */
  source: "none" | "file" | "malformed";
  /** Why, when the file couldn't be trusted. */
  problem?: string;
}

export const POLICY_FILE = ".crew.json";

/**
 * The policy for a workspace. Walks from the workspace up to its git root, so launching
 * crew in `repo/src` still picks up `repo/.crew.json`. If several files apply, the
 * strictest wins: a nested `cloud:true` cannot loosen a parent's `cloud:false`.
 */
export function loadPolicy(root: string): Policy {
  let ceiling = root;
  for (let d = root; ; d = path.dirname(d)) {
    if (fs.existsSync(path.join(d, ".git"))) {
      ceiling = d;
      break;
    }
    if (path.dirname(d) === d) break; // not inside a repo: only look at the workspace itself
  }
  let found: Policy | null = null;
  let map: string | undefined;
  for (let d = root; ; d = path.dirname(d)) {
    const p = readPolicyFile(path.join(d, POLICY_FILE));
    if (p?.map && !map) map = p.map; // nearest file that names a map wins
    if (p && (!p.cloud || !found)) {
      found = p;
      if (!p.cloud) break; // nearest restrictive file wins
    }
    if (d === ceiling || path.dirname(d) === d) break;
  }
  const policy: Policy = found ?? { cloud: true, source: "none" };
  return map ? { ...policy, map } : policy;
}

function readPolicyFile(file: string): Policy | null {
  const name = `${POLICY_FILE}${path.dirname(file) === "." ? "" : ` at ${file}`}`;
  try {
    fs.lstatSync(file); // lstat: a dangling symlink still counts as "present"
  } catch (e: any) {
    if (e?.code === "ENOENT") return null;
    return closed(`${name} can't be inspected (${e?.message || e})`, file);
  }
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (e: any) {
    return closed(`${name} exists but can't be read (${e?.code === "ENOENT" ? "dangling symlink" : e?.message || e})`, file);
  }
  let data: any;
  try {
    data = JSON.parse(raw);
  } catch (e: any) {
    return closed(`${name} is not valid JSON (${e?.message || e})`, file);
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) return closed(`${name} must be a JSON object`, file);
  if (data.cloud !== undefined && typeof data.cloud !== "boolean") return closed(`${name}: "cloud" must be true or false`, file);
  if (data.map !== undefined && (typeof data.map !== "string" || !data.map.trim())) return closed(`${name}: "map" must be a non-empty path string`, file);
  return { cloud: data.cloud ?? true, source: "file", file, map: data.map?.trim() };
}

// A policy we can't read is treated as the strictest one: a typo must not leak PHI.
const closed = (problem: string, file?: string): Policy => ({ cloud: false, source: "malformed", problem, file });

export function describePolicy(p: Policy): string {
  if (p.source === "none") return `none (no ${POLICY_FILE}): cloud workers allowed`;
  if (p.source === "malformed") return `cloud:false, FAILING CLOSED because ${p.problem}. Fix or remove ${POLICY_FILE}.`;
  const where = p.file ? ` (${p.file})` : "";
  return p.cloud ? `${POLICY_FILE}${where}: cloud workers allowed` : `${POLICY_FILE}${where}: cloud:false, local workers only`;
}

/** Why a cloud:false policy applies, for error messages. */
export function policyReason(p: Policy): string {
  return p.source === "malformed" ? `repo policy (${POLICY_FILE} is unreadable, so crew is failing closed: ${p.problem})` : `repo policy (${POLICY_FILE} cloud:false)`;
}

function isPrivateHost(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, "").toLowerCase();
  if (h === "localhost" || h.endsWith(".localhost")) return true;
  const kind = net.isIP(h);
  if (kind === 4) {
    const [a, b] = h.split(".").map(Number);
    return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254);
  }
  if (kind === 6) return h === "::1" || /^f[cd]/.test(h) || /^fe[89ab]/.test(h);
  return false; // a real hostname could resolve anywhere
}

/**
 * Local = content stays on this machine or private network. Ollama and OpenAI-style
 * workers count only if their baseUrl host is loopback or private; codex-cli is always cloud.
 */
export function isLocalWorker(w: WorkerConfig): boolean {
  if (w.provider === "codex-cli") return false;
  const base = w.baseUrl || (w.provider === "ollama" ? "http://localhost:11434" : "https://api.openai.com/v1");
  try {
    return isPrivateHost(new URL(base).hostname);
  } catch {
    return false;
  }
}
