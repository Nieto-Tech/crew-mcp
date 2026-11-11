// Unit tests for the fix a worker timeout suggests (timeoutFix). No server, no model.
import { test } from "node:test";
import assert from "node:assert/strict";
import { QUICK_LIMITS } from "../dist/config.js";
import { timeoutFix } from "../dist/workers.js";

const api = (o = {}) => ({ provider: "openai", model: "m", baseUrl: "https://api.example.com/v1", ...o });

test("timeoutFix: when depth quick set the time, it says so and doesn't point at the config", () => {
  const out = timeoutFix("apiworker", api({ timeoutMs: 480_000 }), QUICK_LIMITS);
  assert.match(out, /depth "quick" caps every worker at 150s, below "apiworker"'s own 480s/);
  assert.match(out, /Ask for depth "deep"/);
  assert.match(out, /narrow the request with `paths`/);
  assert.doesNotMatch(out, /raise timeoutMs|config\.json/, "raising timeoutMs can't help under the cap");
});

test("timeoutFix: a worker with no timeoutMs gets the 300s default, which quick also lowers", () => {
  assert.match(timeoutFix("apiworker", api(), QUICK_LIMITS), /caps every worker at 150s, below "apiworker"'s own 300s/);
});

test("timeoutFix: with no limits, or limits that don't lower this worker's time, the config fix stands", () => {
  for (const [w, limits] of [
    [api({ timeoutMs: 480_000 }), undefined],
    [api({ timeoutMs: 90_000 }), QUICK_LIMITS], // its own 90s is already under quick's 150s
    [api({ timeoutMs: 150_000 }), QUICK_LIMITS], // equal: the config is what set it
  ]) {
    const out = timeoutFix("apiworker", w, limits);
    assert.match(out, /raise timeoutMs for "apiworker" in .*config\.json/);
    assert.doesNotMatch(out, /depth "quick"/);
  }
});
