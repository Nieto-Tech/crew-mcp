#!/usr/bin/env node
// Run every test/*.test.mjs with node --test. The file list is built here rather than by a glob in package.json:
// Node 20 doesn't expand globs itself and Windows shells don't either, and with no file arguments node --test would
// also pick up helpers under test/ (test/fixtures/*.mjs). Extra arguments are passed through to node --test.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "test");
const files = fs.readdirSync(dir).filter((f) => f.endsWith(".test.mjs")).sort().map((f) => path.join(dir, f));
if (!files.length) {
  console.error(`no test files in ${dir}`);
  process.exit(1);
}
// The timeout applies to each test file as a whole as well as to each test: the e2e file takes ~20s on Linux but
// over a minute on Windows CI (it starts dozens of server processes). 5 minutes still fails a hang.
const r = spawnSync(process.execPath, ["--test", "--test-timeout=300000", ...process.argv.slice(2), ...files], { stdio: "inherit" });
process.exit(r.status ?? 1);
