import path from "node:path";

export interface FileStat {
  file: string;
  added: number;
  removed: number;
}

/** Per-file +/- counts, read from the unified diff text itself (untracked files included). */
export function diffStats(diff: string): FileStat[] {
  const stats: FileStat[] = [];
  let cur: FileStat | null = null;
  for (const line of diff.split("\n")) {
    const m = /^diff --git a\/.* b\/(.*)$/.exec(line);
    if (m) {
      cur = { file: m[1], added: 0, removed: 0 };
      stats.push(cur);
    } else if (cur && line.startsWith("+") && !line.startsWith("+++")) cur.added++;
    else if (cur && line.startsWith("-") && !line.startsWith("---")) cur.removed++;
  }
  return stats;
}

/** Changed files grouped by directory, biggest churn first. */
export function groupByDirectory(stats: FileStat[], maxDirs = 20, maxFilesPerDir = 6): string[] {
  const dirs = new Map<string, FileStat[]>();
  for (const s of stats) {
    const d = path.posix.dirname(s.file);
    dirs.set(d, [...(dirs.get(d) || []), s]);
  }
  const churn = (l: FileStat[]) => l.reduce((n, s) => n + s.added + s.removed, 0);
  const sorted = [...dirs.entries()].sort((a, b) => churn(b[1]) - churn(a[1]));
  const out: string[] = [];
  for (const [d, list] of sorted.slice(0, maxDirs)) {
    const add = list.reduce((n, s) => n + s.added, 0);
    const del = list.reduce((n, s) => n + s.removed, 0);
    out.push(`- \`${d === "." ? "(root)" : d + "/"}\`: ${list.length} file(s), +${add}/-${del}`);
    const top = [...list].sort((a, b) => b.added + b.removed - (a.added + a.removed));
    for (const s of top.slice(0, maxFilesPerDir)) out.push(`    - \`${path.posix.basename(s.file)}\` +${s.added}/-${s.removed}`);
    if (top.length > maxFilesPerDir) out.push(`    - …and ${top.length - maxFilesPerDir} more`);
  }
  if (sorted.length > maxDirs) out.push(`- …and ${sorted.length - maxDirs} more director${sorted.length - maxDirs === 1 ? "y" : "ies"}`);
  return out;
}

/** The "too large" message returned instead of a review. */
export function tooLargeMessage(o: { chars: number; limit: number; worker: string; stats: FileStat[]; base: string }): string {
  const add = o.stats.reduce((n, s) => n + s.added, 0);
  const del = o.stats.reduce((n, s) => n + s.removed, 0);
  return [
    `Diff too large to review well: ${o.chars.toLocaleString("en-US")} chars across ${o.stats.length} changed file(s) (+${add}/-${del}) vs ${o.base}; ` +
      `the scout (${o.worker}) can take at most ${o.limit.toLocaleString("en-US")} chars. No model was called.`,
    "",
    "## Changed files by directory",
    ...groupByDirectory(o.stats),
    "",
    "Re-run `crew_review_diff` with `paths` set to the riskiest files or directories above (auth, payments, migrations, data access), " +
      "or pass `force: true` to review anyway (the diff is truncated, so later files go unseen and it may time out).",
  ].join("\n");
}
