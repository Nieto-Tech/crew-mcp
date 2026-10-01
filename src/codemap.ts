import fs from "node:fs/promises";
import type { Workspace } from "./workspace.js";
import type { Policy } from "./policy.js";

/** Where a repo's code map lives unless .crew.json says otherwise ("map"). */
export const DEFAULT_MAP = "docs/CODEMAP.md";
/** Most characters of map sent to the scout. */
export const MAP_CAP = 8_000;
const MAP_READ_LIMIT = 2_000_000;

export interface CodeMap {
  /** Workspace-relative path of the map file. */
  file: string;
  /** What the scout gets: the map minus stale lines, capped. Empty when nothing usable is left. */
  text: string;
  /** Paths the map mentions that don't exist, sorted. */
  stale: string[];
  /** Lines dropped because they mention a stale path. */
  droppedLines: number;
  /** Length of the valid map before the cap, set only when it was truncated. */
  truncatedFrom?: number;
  /** Set when the map file exists but can't be used (outside the workspace, unreadable). */
  problem?: string;
}

const EXT =
  "ts|tsx|js|jsx|mjs|cjs|json|md|mdx|py|go|rs|java|kt|rb|php|sql|ya?ml|toml|sh|css|scss|html|tf|vue|svelte|c|h|cpp|cs|swift|prisma|graphql|proto|xml|txt";
const EXT_END = new RegExp(`\\.(?:${EXT})$`, "i");
const BARE_PATH = new RegExp(`(?<![\\w\`/.@:~-])((?:\\./)?[\\w.@-]+(?:/[\\w.@-]+)+\\.(?:${EXT}))(?::\\d+(?:-\\d+)?)?(?![\\w/])`, "gi");

/** Turn a token from the map into a workspace-relative path, or null if it isn't a repo path reference. */
function normalize(raw: string, topLevel: Set<string>): string | null {
  let t = raw.trim().replace(/[#?].*$/, "").replace(/:\d+(?:-\d+)?$/, "").replace(/^\.\//, "");
  if (!t.includes("/") || t.startsWith("/") || t.startsWith("@") || t.startsWith("~") || t.startsWith("..")) return null;
  if (/[\s*?{}<>$|()[\]=:,;'"\\]/.test(t)) return null; // globs, placeholders, routes, commands
  t = t.replace(/\/{2,}/g, "/");
  // `and/or` is prose, `src/gone/` is a stale dir: a bare token counts as a path only if it looks like one.
  const looksLikePath = EXT_END.test(t) || t.endsWith("/") || topLevel.has(t.split("/")[0]);
  return looksLikePath ? t.replace(/\/$/, "") : null;
}

function pathsIn(line: string, topLevel: Set<string>): string[] {
  const out = new Set<string>();
  const add = (raw: string) => {
    const p = normalize(raw, topLevel);
    if (p) out.add(p);
  };
  const plain = line.replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, " "); // URLs are not repo paths
  for (const m of plain.matchAll(/`([^`\n]+)`/g)) add(m[1]);
  for (const m of plain.matchAll(/\]\(([^)\s]+)\)/g)) if (!/^(#|mailto:)/.test(m[1])) add(m[1]);
  for (const m of plain.matchAll(BARE_PATH)) add(m[1]);
  return [...out];
}

/** Strip stale lines and cap the size. Pure, so it is easy to test. */
export function filterMap(raw: string, files: string[], file: string): CodeMap {
  const topLevel = new Set(files.map((f) => f.split("/")[0]));
  const known = new Set(files);
  const dirs = new Set<string>();
  for (const f of files) for (let i = f.indexOf("/"); i !== -1; i = f.indexOf("/", i + 1)) dirs.add(f.slice(0, i));
  const exists = (p: string) => known.has(p) || dirs.has(p);

  const stale = new Set<string>();
  const kept: string[] = [];
  let droppedLines = 0;
  for (const line of raw.split(/\r?\n/)) {
    const bad = pathsIn(line, topLevel).filter((p) => !exists(p));
    if (bad.length) {
      bad.forEach((p) => stale.add(p));
      droppedLines++;
    } else kept.push(line);
  }
  let text = kept.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  let truncatedFrom: number | undefined;
  if (text.length > MAP_CAP) {
    truncatedFrom = text.length;
    const cut = text.slice(0, MAP_CAP);
    text = cut.slice(0, Math.max(cut.lastIndexOf("\n"), 0) || MAP_CAP).trimEnd();
  }
  return { file, text, stale: [...stale].sort(), droppedLines, truncatedFrom };
}

/** The workspace's code map, checked against the files that exist. Null when there is none. */
export async function loadCodeMap(ws: Workspace, policy: Policy): Promise<CodeMap | null> {
  const file = policy.map || DEFAULT_MAP;
  let real: string;
  try {
    real = await ws.resolve(file); // refuses anything that escapes the workspace, symlinks included
  } catch (e: any) {
    // A missing default map is normal. A missing or out-of-bounds configured one is worth saying.
    if (!policy.map && /^File not found/.test(e?.message)) return null;
    return { file, text: "", stale: [], droppedLines: 0, problem: e?.message || String(e) };
  }
  try {
    const st = await fs.stat(real);
    if (!st.isFile()) return { file, text: "", stale: [], droppedLines: 0, problem: "not a file" };
    if (st.size > MAP_READ_LIMIT) return { file, text: "", stale: [], droppedLines: 0, problem: `larger than ${MAP_READ_LIMIT / 1e6}MB` };
    return filterMap(await fs.readFile(real, "utf8"), await ws.listFiles(), file);
  } catch (e: any) {
    return { file, text: "", stale: [], droppedLines: 0, problem: e?.message || String(e) };
  }
}

const listStale = (paths: string[]) => paths.slice(0, 10).join(", ") + (paths.length > 10 ? `, … (+${paths.length - 10} more)` : "");

/** One line for the tool output: what was used, what was left out. */
export function mapNote(m: CodeMap | null): string {
  if (!m) return "";
  if (m.problem) return `_code map ${m.file} not used: ${m.problem}_`;
  const bits = [m.text ? `sent to the scout (${m.text.length} chars${m.truncatedFrom ? `, truncated from ${m.truncatedFrom}` : ""})` : "nothing usable left to send"];
  if (m.stale.length) bits.push(`excluded ${m.droppedLines} line(s) naming ${m.stale.length} stale path(s): ${listStale(m.stale)}`);
  return `_code map ${m.file}: ${bits.join("; ")}_`;
}

/** The status-page line. */
export function mapStatus(m: CodeMap | null): string {
  if (!m) return `none (no ${DEFAULT_MAP}; set "map" in .crew.json to use another file)`;
  if (m.problem) return `${m.file}: NOT USED (${m.problem})`;
  return (
    `${m.file}: ${m.text.length} chars usable${m.truncatedFrom ? ` (truncated from ${m.truncatedFrom})` : ""}, ` +
    (m.stale.length ? `${m.stale.length} stale path(s) excluded: ${listStale(m.stale)}` : "no stale paths")
  );
}
