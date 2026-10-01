/** Split "repo:tag" at the tag colon (the last one, after the last slash). No tag means "latest". */
function parts(name: string): { repo: string; tag: string } {
  const slash = name.lastIndexOf("/");
  const colon = name.indexOf(":", slash + 1);
  return colon < 0 ? { repo: name, tag: "latest" } : { repo: name.slice(0, colon), tag: name.slice(colon + 1) || "latest" };
}

/** Same model? The repo part must match exactly; the tag is case-insensitive (Q4_K_M vs q4_K_M) and defaults to latest. */
export function sameModel(a: string, b: string): boolean {
  const x = parts(a);
  const y = parts(b);
  return x.repo === y.repo && x.tag.toLowerCase() === y.tag.toLowerCase();
}

/** The installed spelling of a wanted model, if it is installed. */
export function findModel(installed: string[], want: string): string | undefined {
  return installed.find((n) => n === want) ?? installed.find((n) => sameModel(n, want));
}

function distance(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length];
}

/** Installed names nearest to a wanted one: same repo (any case) first, then by edit distance. */
export function closestModels(installed: string[], want: string, limit = 3): string[] {
  const w = want.toLowerCase();
  const wr = parts(want).repo.toLowerCase();
  return [...installed]
    .map((n) => ({ n, sameRepo: parts(n).repo.toLowerCase() === wr, d: distance(w, n.toLowerCase()) }))
    .sort((a, b) => Number(b.sameRepo) - Number(a.sameRepo) || a.d - b.d || a.n.localeCompare(b.n))
    .slice(0, limit)
    .map((x) => x.n);
}
