import fs from "node:fs/promises";
import path from "node:path";
import { Workspace } from "./workspace.js";

/* ---------- JSON extraction ----------
 * Models write prose first and JSON last, and the prose often contains braces.
 * Find every balanced {...} (string-aware), try from last to first, accept the
 * first that parses AND passes the shape check. */

function balancedObjects(text: string): string[] {
  const out: string[] = [];
  for (let start = text.indexOf("{"); start !== -1; start = text.indexOf("{", start + 1)) {
    let depth = 0;
    let inStr = false;
    let esc = false;
    for (let i = start; i < text.length; i++) {
      const c = text[i];
      if (inStr) {
        if (esc) esc = false;
        else if (c === "\\") esc = true;
        else if (c === '"') inStr = false;
        continue;
      }
      if (c === '"') inStr = true;
      else if (c === "{") depth++;
      else if (c === "}" && --depth === 0) {
        out.push(text.slice(start, i + 1));
        break;
      }
    }
  }
  return out;
}

export function extractJson<T>(text: string, isValid: (v: any) => boolean): T | null {
  const raw = String(text || "").trim();
  const tryParse = (s: string) => {
    try {
      const v = JSON.parse(s);
      return isValid(v) ? (v as T) : undefined;
    } catch {
      return undefined;
    }
  };
  const whole = tryParse(raw);
  if (whole !== undefined) return whole;
  for (const [, body] of [...raw.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)].reverse()) {
    const v = tryParse(body.trim());
    if (v !== undefined) return v;
  }
  for (const c of balancedObjects(raw).reverse()) {
    const v = tryParse(c);
    if (v !== undefined) return v;
  }
  return null;
}

export const normalizeWs = (s: string) => String(s).replace(/\s+/g, " ").trim();

/* ---------- Reformat guard ---------- */

/** True when a parsed answer says anything: a non-blank string at any depth. An all-empty skeleton says nothing. */
export const hasContent = (v: unknown): boolean =>
  typeof v === "string" ? v.trim() !== ""
  : Array.isArray(v) ? v.some(hasContent)
  : !!v && typeof v === "object" && Object.values(v).some(hasContent);

/** The strings a reformat must not invent: file paths (`file`, `path`, `files`) and quoted `evidence`, anywhere in the JSON. */
function groundedStrings(v: unknown, out: { kind: "path" | "evidence"; value: string }[] = []) {
  if (Array.isArray(v)) for (const x of v) groundedStrings(x, out);
  else if (v && typeof v === "object") {
    for (const [k, x] of Object.entries(v)) {
      if ((k === "file" || k === "path") && typeof x === "string") out.push({ kind: "path", value: x });
      else if (k === "files" && Array.isArray(x)) for (const f of x) typeof f === "string" ? out.push({ kind: "path", value: f }) : groundedStrings(f, out);
      else if (k === "evidence" && typeof x === "string") out.push({ kind: "evidence", value: x });
      else groundedStrings(x, out);
    }
  }
  return out;
}

/**
 * The first path or evidence string in a reformatted answer that isn't in the raw answer it was made from, or
 * null if it introduced none. Whitespace-insensitive; a path's `:line` suffix is ignored; the raw answer is also
 * tried with JSON string escapes undone, since a near-miss JSON answer quotes code as `\"x\"`.
 */
export function introducedBy(reformatted: unknown, raw: string): string | null {
  const hay = [normalizeWs(raw), normalizeWs(raw.replace(/\\n/g, "\n").replace(/\\t/g, "\t").replace(/\\(["\\/])/g, "$1"))];
  for (const { kind, value } of groundedStrings(reformatted)) {
    const needle = normalizeWs(kind === "path" ? value.replace(/:\d+(?:-\d+)?$/, "") : value);
    if (needle && !hay.some((h) => h.includes(needle))) return kind === "path" ? value : `"${value.length > 80 ? value.slice(0, 77) + "..." : value}"`;
  }
  return null;
}

/* ---------- Path resolution for model-written file references ---------- */

// Build outputs, worktrees and caches often hold copies of source files.
const DUPLICATE_TREE_RE =
  /(^|\/)(dist|build|out|coverage|\.next|\.nuxt|\.turbo|\.cache|\.claude|\.cline|worktrees?|\.worktrees|tmp|vendor|__snapshots__)(\/|$)/;

export async function lineCount(ws: Workspace, file: string): Promise<number> {
  try {
    return (await fs.readFile(await ws.resolve(file), "utf8")).split(/\r?\n/).length;
  } catch {
    return -1;
  }
}

/** Resolve "server.ts" / "routes/x.ts" / full paths to one workspace file. */
export async function resolveCited(
  ws: Workspace,
  files: string[],
  cited: string,
  opts: { preferred?: Set<string>; start?: number; end?: number } = {}
): Promise<{ file?: string; reason?: string; note?: string }> {
  const clean = cited.replace(/^\.\//, "").replace(/^\/+/, "");
  if (files.includes(clean)) return { file: clean };

  let cands = files.filter((f) => f.endsWith("/" + clean));
  const primary = cands.filter((f) => !DUPLICATE_TREE_RE.test(f));
  if (primary.length) cands = primary;
  if (cands.length === 1) return { file: cands[0], note: "resolved shortened path" };
  if (!cands.length) return { reason: "file not found in workspace" };

  const pref = opts.preferred ? cands.filter((f) => opts.preferred!.has(f)) : [];
  if (pref.length === 1) return { file: pref[0], note: "disambiguated by context" };

  if (opts.start) {
    const fitting: string[] = [];
    for (const f of pref.length ? pref : cands) {
      const n = await lineCount(ws, f);
      if (n > 0 && opts.start >= 1 && (opts.end ?? opts.start) <= n) fitting.push(f);
    }
    if (fitting.length === 1) return { file: fitting[0], note: "disambiguated by line range" };
    if (!fitting.length) return { reason: `line range fits none of ${cands.length} candidates (${cands.slice(0, 3).join(", ")})` };
  }
  return { reason: `ambiguous: ${cands.length} matches (${cands.slice(0, 3).join(", ")})` };
}

/* ---------- Citation check (file:line and file:start-end) ---------- */

/**
 * The identifier a citation is about: only one directly in front of it, like
 * `foo` (`file.ts:12`) or `foo` at file.ts:12. A name elsewhere in the same
 * paragraph usually belongs to a different claim, so it isn't checked.
 */
function adjacentIdentifier(line: string, citation: string): string | undefined {
  const at = line.indexOf(citation);
  if (at < 0) return undefined;
  const before = line.slice(Math.max(0, at - 60), at);
  const m = [...before.matchAll(/`([A-Za-z_$][\w$]{3,})(?:\(\))?`/g)].pop();
  if (!m) return undefined;
  const gap = before.slice((m.index ?? 0) + m[0].length);
  if (!/^[\s(`:,\u2013\u2014-]*(?:at|in|on)?[\s(`:]*$/i.test(gap)) return undefined;
  return m[1];
}

export interface CitationResult {
  citation: string;
  ok: boolean;
  resolvedFile?: string;
  reason?: string;
  note?: string;
  identifier?: string;
  identifierFound?: boolean;
}

export async function checkCitations(ws: Workspace, text: string): Promise<{ total: number; results: CitationResult[] }> {
  const files = await ws.listFiles();
  const known = new Set(files);
  const preferred = new Set<string>();
  for (const m of String(text).matchAll(/[\w@.-]+(?:\/[\w@.-]+)+\.[A-Za-z]{1,8}/g)) if (known.has(m[0])) preferred.add(m[0]);

  const re = /([\w@.-]+(?:\/[\w@.-]+)*\.[A-Za-z]{1,8}):(\d+)(?:\s*[-–]\s*(\d+))?/g;
  const results: CitationResult[] = [];
  const lines = String(text).split(/\r?\n/);

  for (const m of String(text).matchAll(re)) {
    const start = Number(m[2]);
    const end = Number(m[3] || m[2]);
    const r = await resolveCited(ws, files, m[1], { preferred, start, end });
    const res: CitationResult = { citation: m[0], ok: false, resolvedFile: r.file, reason: r.reason, note: r.note };

    if (r.file) {
      const n = await lineCount(ws, r.file);
      if (n < 0) res.reason = "file could not be read";
      else if (end < start) res.reason = `inverted range ${start}-${end}`;
      else if (start < 1 || end > n) res.reason = `line range outside file (file has ${n} lines)`;
      else res.ok = true;

      // If a backticked identifier sits right next to the citation, check it
      // really appears near the cited lines. Catches "right file, wrong place".
      if (res.ok) {
        const line = lines.find((l) => l.includes(m[0])) || "";
        const ident = adjacentIdentifier(line, m[0]);
        if (ident) {
          const body = (await fs.readFile(await ws.resolve(r.file), "utf8")).split(/\r?\n/);
          const lo = Math.max(0, start - 1 - 3);
          const hi = Math.min(body.length, end + 3);
          res.identifier = ident;
          res.identifierFound = body.slice(lo, hi).some((l) => l.includes(ident));
          if (!res.identifierFound) {
            res.ok = false;
            res.reason = `\`${ident}\` not found near lines ${start}-${end}`;
          }
        }
      }
    }
    results.push(res);
  }
  return { total: results.length, results };
}

/* ---------- Evidence verification for model findings ---------- */

export interface Finding {
  severity?: string;
  category?: string;
  file?: string | null;
  line?: number | null;
  claim: string;
  evidence?: string;
  suggestion?: string;
}

export interface CheckedFinding extends Finding {
  verified: boolean;
  resolvedFile?: string;
  why: string;
}

/**
 * A finding is "verified" only if its evidence quote actually appears in the
 * cited file (current working tree) or in the diff. That's the gate that keeps
 * a small local model from blocking Claude on hallucinations.
 */
const MIN_QUOTE_CHARS = 8; // non-whitespace characters
const DISTINCTIVE_QUOTE_CHARS = 20;
const ANCHOR_WINDOW = 8; // lines either side of the cited line

const nonSpaceLen = (s: string) => s.replace(/\s/g, "").length;

/**
 * Every place a whitespace-normalized quote occurs in a file, as 1-based first and last lines.
 * The file is normalized line by line, so each match maps back to the lines it spans.
 */
export function locateQuote(lines: string[], quote: string): { start: number; end: number }[] {
  const starts: number[] = []; // offset in `body` where each line begins
  const lineAt: number[] = []; // the line number for each entry in `starts`
  let body = "";
  lines.forEach((l, i) => {
    const n = normalizeWs(l);
    if (!n) return;
    if (body) body += " ";
    starts.push(body.length);
    lineAt.push(i + 1);
    body += n;
  });
  const lineOf = (off: number) => {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid] <= off) lo = mid;
      else hi = mid - 1;
    }
    return lineAt[lo];
  };
  const out: { start: number; end: number }[] = [];
  if (!quote) return out;
  for (let at = body.indexOf(quote); at !== -1; at = body.indexOf(quote, at + 1)) {
    out.push({ start: lineOf(at), end: lineOf(at + quote.length - 1) });
  }
  return out;
}

/**
 * A finding passes only if its quote is real AND pinned down:
 * - found within a few lines of the cited line, or
 * - found exactly once in the file and long enough to be distinctive.
 * A short, common quote like "throw err;" somewhere else in the file proves nothing.
 * Passing means the quoted code exists where claimed, NOT that the claim is right.
 * A passing finding's `line` is moved to where the quote really is, so the headline
 * `file:line` points at the code; `why` keeps the line the model cited.
 */
export async function verifyFindings(ws: Workspace, findings: Finding[], diffText = ""): Promise<CheckedFinding[]> {
  const files = await ws.listFiles();
  const diffNorm = normalizeWs(diffText.replace(/^[+-]/gm, ""));
  const out: CheckedFinding[] = [];

  for (const f of findings) {
    const evidence = typeof f.evidence === "string" ? f.evidence.trim() : "";
    if (!evidence) {
      out.push({ ...f, verified: false, why: "no evidence quote" });
      continue;
    }
    const ev = normalizeWs(evidence.replace(/^\s*\d+\s*\|\s?/gm, ""));
    const evLen = nonSpaceLen(ev);
    if (evLen < MIN_QUOTE_CHARS) {
      out.push({ ...f, verified: false, why: "quote too short to pin down" });
      continue;
    }
    const inDiff = !!diffNorm && diffNorm.includes(ev);

    if (!f.file) {
      const ok = inDiff && evLen >= 12;
      out.push({ ...f, verified: ok, why: ok ? "quote found in diff" : "no file given and quote not found in diff" });
      continue;
    }
    const r = await resolveCited(ws, files, f.file, {});
    if (!r.file) {
      out.push({ ...f, verified: false, why: r.reason || "file not resolved" });
      continue;
    }

    const raw = (await fs.readFile(await ws.resolve(r.file), "utf8")).split(/\r?\n/);
    const line = typeof f.line === "number" && f.line > 0 ? f.line : 0;
    const hits = locateQuote(raw, ev);
    if (line) {
      // The whole quote must sit inside the window; of several that do, take the one nearest the cited line.
      const near = hits
        .filter((h) => h.start >= line - ANCHOR_WINDOW && h.end <= line + ANCHOR_WINDOW)
        .sort((a, b) => Math.abs(a.start - line) - Math.abs(b.start - line))[0];
      if (near) {
        const why = near.start === line ? "quote found at cited line" : `quote found at line ${near.start}, near the cited line ${line}`;
        out.push({ ...f, line: near.start, verified: true, resolvedFile: r.file, why });
        continue;
      }
    }

    const n = hits.length;
    if (n === 1 && evLen >= DISTINCTIVE_QUOTE_CHARS) {
      const actual = hits[0].start;
      out.push({
        ...f,
        line: actual,
        verified: true,
        resolvedFile: r.file,
        why: line ? `quote found at line ${actual}, not the cited line ${line}` : `quote found once in file (line ${actual})`,
      });
    } else if (n > 1) {
      out.push({ ...f, verified: false, resolvedFile: r.file, why: `quote appears ${n}× in file${line ? ", none near the cited line" : ""}: too generic to pin down` });
    } else if (n === 1) {
      out.push({ ...f, verified: false, resolvedFile: r.file, why: line ? "short quote found, but not near the cited line" : "quote too short to pin down without a line number" });
    } else if (inDiff && evLen >= 12) {
      out.push({ ...f, verified: true, resolvedFile: r.file, why: "quote found in diff (changed or removed line)" });
    } else {
      out.push({ ...f, verified: false, resolvedFile: r.file, why: "quote not found in file or diff" });
    }
  }
  return out;
}

/* ---------- Severity triage for checked findings ---------- */

const COMMENT_LINE_RE = /^\s*(\/\/|\/\*|\*|#|--|<!--)/;

/** True when every non-blank line of a quote is a comment. A "12 | " line-number prefix is ignored, as in the quote gate. */
export const isCommentOnly = (quote: string) => {
  const lines = String(quote).replace(/^\s*\d+\s*\|\s?/gm, "").split(/\r?\n/).filter((l) => l.trim());
  return lines.length > 0 && lines.every((l) => COMMENT_LINE_RE.test(l));
};

/**
 * The package.json files above `file`, nearest first, and whether any of them has a test script.
 * `undefined` when there is no package.json above it: other ecosystems aren't judged.
 */
export async function hasTestRunner(ws: Workspace, files: string[], file: string): Promise<{ runner: boolean; nearest: string } | undefined> {
  const slash = (p: string) => p.replace(/\\/g, "/"); // the non-git file walk lists Windows paths
  const known = new Set(files.map(slash));
  const pkgs: string[] = [];
  for (let dir = path.posix.dirname(slash(file)); ; dir = path.posix.dirname(dir)) {
    const p = dir === "." ? "package.json" : `${dir}/package.json`;
    if (known.has(p)) pkgs.push(p);
    if (dir === "." || dir === "/" || !dir) break;
  }
  if (!pkgs.length) return undefined;
  for (const p of pkgs) {
    try {
      const scripts = JSON.parse(await fs.readFile(await ws.resolve(p), "utf8"))?.scripts || {};
      // npm init's placeholder ("Error: no test specified") is not a runner.
      if (Object.entries(scripts).some(([k, v]) => /^test(\b|:)/.test(k) && typeof v === "string" && !/no test specified/i.test(v))) {
        return { runner: true, nearest: pkgs[0] };
      }
    } catch {
      return undefined; // unreadable or not JSON: don't judge
    }
  }
  return { runner: false, nearest: pkgs[0] };
}

const capLow = (f: CheckedFinding, reason: string): CheckedFinding =>
  (f.severity || "").toLowerCase() === "low" ? { ...f, why: `${f.why}; ${reason}` } : { ...f, severity: "low", why: `${f.why}; capped at low: ${reason}` };

/**
 * Lower the severity of findings whose quote shows they can't be worth more:
 * - the quote is only a comment, so the fix is (almost always) editing that comment;
 * - a "tests" finding in a JS package with no test script, which can't act on it.
 * Never changes whether a finding is quote-checked.
 */
export async function triageFindings(ws: Workspace, checked: CheckedFinding[]): Promise<CheckedFinding[]> {
  const files = await ws.listFiles();
  const out: CheckedFinding[] = [];
  for (let f of checked) {
    if (f.evidence && isCommentOnly(f.evidence)) f = capLow(f, "the quote is only a comment");
    const file = f.resolvedFile || f.file;
    if ((f.category || "").toLowerCase() === "tests" && file) {
      const t = await hasTestRunner(ws, files, file);
      if (t && !t.runner) f = capLow(f, `no test script in ${t.nearest}`);
    }
    out.push(f);
  }
  return out;
}

/* ---------- Findings the lead already weighed ---------- */

/** The `file:line` an acknowledged entry starts with (the headline of an earlier finding), or null for free text. */
export function parseAck(entry: string): { file: string; line: number } | null {
  const m = String(entry).match(/^\s*`?([\w@.-]+(?:[\\/][\w@.-]+)*\.[A-Za-z]{1,8}):(\d+)/);
  return m && Number(m[2]) > 0 ? { file: m[1], line: Number(m[2]) } : null;
}

/**
 * Split findings into new ones and ones matching an acknowledged entry: same file, line within the
 * quote gate's window. Lines shift a little when the lead edits between runs; a finding further off is
 * kept as new. Free-text entries only reach the prompt. Matched findings are shown collapsed, not dropped.
 * `unplaced` lists entries whose file:line names no file in the workspace, so the caller can say so.
 */
export async function splitAcknowledged<T extends CheckedFinding>(
  ws: Workspace,
  findings: T[],
  acknowledged: string[]
): Promise<{ fresh: T[]; acked: { finding: T; entry: string }[]; unplaced: string[] }> {
  const files = await ws.listFiles();
  const acks: { file: string; line: number; entry: string }[] = [];
  const unplaced: string[] = [];
  for (const entry of acknowledged) {
    const a = parseAck(entry);
    if (!a) continue;
    const r = await resolveCited(ws, files, a.file, { start: a.line });
    if (r.file) acks.push({ file: r.file, line: a.line, entry });
    else unplaced.push(entry);
  }
  const fresh: T[] = [];
  const acked: { finding: T; entry: string }[] = [];
  for (const f of findings) {
    const at = typeof f.line === "number" ? f.line : 0;
    const hit = at && f.resolvedFile ? acks.find((a) => a.file === f.resolvedFile && Math.abs(a.line - at) <= ANCHOR_WINDOW) : undefined;
    if (hit) acked.push({ finding: f, entry: hit.entry });
    else fresh.push(f);
  }
  return { fresh, acked, unplaced };
}

const SEVERITY_RANK: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };

/** Most severe first; findings of equal severity keep the model's order. */
export const bySeverity = <T extends Finding>(fs: T[]) =>
  [...fs].sort((a, b) => (SEVERITY_RANK[(a.severity || "").toLowerCase()] ?? 4) - (SEVERITY_RANK[(b.severity || "").toLowerCase()] ?? 4));

export const basenameOf = (p: string) => path.basename(p);
