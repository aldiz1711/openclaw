import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";

const [variant, revision, exitCode, resultsDir = "/results"] = process.argv.slice(2);
assert.ok(variant === "before" || variant === "after", "unknown variant");
const revisions = {
  before: "7a2e4eb07446229e851fb1d8dc11bd533dcf5f0d",
  after: "b27f4a9217ce6c1313c5555bcc492b9ba705687f",
};
assert.equal(revision, revisions[variant], "unexpected source revision");
const records = readFileSync(`${resultsDir}/gateway.log`, "utf8")
  .split("\n")
  .filter((line) => line.startsWith("HEARTBEAT_PROOF "))
  .map((line) => JSON.parse(line.slice("HEARTBEAT_PROOF ".length)));
assert.equal(records.length, 2, "both observed scenarios are required");
const [durable, transient] = records;
assert.equal(durable.case, "durable", "durable control must run first");
assert.equal(durable.status, "ok");
assert.equal(durable.ownerExists, true);
assert.equal(durable.childExists, true);
assert.equal(durable.outcomeCount, 1);
assert.equal(durable.toolExecuted, true);
assert.equal(durable.claimPreserved, true);
for (const record of records) {
  assert.deepEqual(record.protocolErrors, [], "provider protocol must complete correctly");
  assert.equal(record.toolCallsSent, 1);
  assert.equal(record.transcriptTool, true);
  assert.equal(record.nodeCount, record.case === "durable" ? 1 : 0);
}
assert.equal(transient.case, "transient");
assert.equal(transient.ownerExists, false);
assert.equal(transient.childExists, true);
assert.equal(transient.outcomeCount, 0);
assert.equal(transient.toolExecuted, true);
if (variant === "before") {
  assert.equal(exitCode, "1", "baseline must fail its success assertion");
  assert.equal(transient.status, "error");
  assert.match(transient.error, /FOREIGN KEY constraint failed/);
} else {
  assert.equal(exitCode, "0", "patched revision must pass the whole test");
  assert.equal(transient.status, "ok");
  assert.ok(!transient.error, "patched cron run must have no error");
}
const verdict = {
  variant,
  revision,
  proofKind: "real-gateway-loopback-provider",
  expectedBaselineFailure: variant === "before",
  records,
};
writeFileSync(`${resultsDir}/verdict.json`, `${JSON.stringify(verdict, null, 2)}\n`);
console.log(JSON.stringify(verdict));
