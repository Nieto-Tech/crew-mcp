import { test } from "node:test";
import assert from "node:assert/strict";
import { closestModels, findModel, sameModel } from "../dist/models.js";

test("tag matching is case-insensitive, the repo part is not", () => {
  assert.ok(sameModel("qwen3:Q4_K_M", "qwen3:q4_k_m"));
  assert.ok(sameModel("hf.co/Org/Repo-GGUF:Q4_K_M", "hf.co/Org/Repo-GGUF:q4_K_M"));
  assert.ok(!sameModel("hf.co/Org/Repo-GGUF:Q4_K_M", "hf.co/org/repo-gguf:Q4_K_M"));
  assert.ok(!sameModel("qwen3:27b", "qwen3:32b"));
});

test("no tag means latest, both ways", () => {
  assert.ok(sameModel("qwen3", "qwen3:latest"));
  assert.ok(sameModel("qwen3:LATEST", "qwen3"));
  assert.ok(!sameModel("qwen3", "qwen3:27b"));
});

test("a registry host:port is not mistaken for a tag", () => {
  assert.ok(sameModel("localhost:5000/team/m:Q8_0", "localhost:5000/team/m:q8_0"));
  assert.ok(!sameModel("localhost:5000/team/m:Q8_0", "localhost:5001/team/m:Q8_0"));
});

test("findModel returns the installed spelling, preferring an exact match", () => {
  assert.equal(findModel(["a:Q4_K_M", "b:1"], "a:q4_k_m"), "a:Q4_K_M");
  assert.equal(findModel(["a:q4_k_m", "a:Q4_K_M"], "a:Q4_K_M"), "a:Q4_K_M");
  assert.equal(findModel(["a:1"], "b:1"), undefined);
});

test("closestModels ranks same repo first, then nearest spelling", () => {
  const installed = ["llama3:8b", "qwen3.8:27b", "qwen3.8:32b", "qwen3.8:4b", "gemma4:31b", "qwen2.5:7b"];
  assert.deepEqual(closestModels(installed, "qwen3.8:28b"), ["qwen3.8:27b", "qwen3.8:32b", "qwen3.8:4b"]);
  assert.equal(closestModels(installed, "gemma4:30b")[0], "gemma4:31b");
  assert.equal(closestModels(installed, "qwen3.8:27b".toUpperCase())[0], "qwen3.8:27b");
  assert.equal(closestModels(installed, "qwen3.7:27b")[0], "qwen3.8:27b", "typo in the repo part still finds the neighbour");
  assert.equal(closestModels(installed, "zzz", 2).length, 2);
  assert.deepEqual(closestModels([], "x"), []);
});
