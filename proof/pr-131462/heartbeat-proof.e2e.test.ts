// Draft boundary proof for PR 131462; copy into test/e2e/qa-lab/runtime before running.
// Protects cron terminal success after a real quiet heartbeat and durable-owner retention.
// Existing store tests bypass tool execution and finalizer-to-cron error propagation.
import fs from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { clearConfigCache, clearRuntimeConfigSnapshot } from "../../../../src/config/config.js";
import { resetConfigOverrides } from "../../../../src/config/runtime-overrides.js";
import { loadSessionEntry, replaceSessionEntry } from "../../../../src/config/sessions/session-accessor.js";
import { clearSessionStoreCacheForTest } from "../../../../src/config/sessions/store-writer-state.js";
import type { OpenClawConfig } from "../../../../src/config/types.openclaw.js";
import { readSessionMessagesAsync } from "../../../../src/gateway/session-transcript-readers.js";
import { disconnectGatewayClient, startGatewayWithClient } from "../../../../src/gateway/test-helpers.e2e.js";
import { buildMockOpenAiResponsesProvider } from "../../../../src/gateway/test-openai-responses-model.js";
import { resetAgentEventsForTest } from "../../../../src/infra/agent-events.js";
import { claimHeartbeatOutcomeForRun } from "../../../../src/infra/heartbeat-outcome-store.js";
import { resetSystemEventsForTest } from "../../../../src/infra/system-events.js";
import { openOpenClawAgentDatabase } from "../../../../src/state/openclaw-agent-db.js";
import { resetTaskRegistryForTests } from "../../../../src/tasks/task-runtime.test-helpers.js";
import { captureEnv, deleteTestEnvValue, setTestEnvValue } from "../../../../src/test-utils/env.js";
import { useAutoCleanupTempDirTracker } from "../../../helpers/temp-dir.js";

const envKeys = ["OPENCLAW_TEST_FAST", "HOME", "OPENCLAW_STATE_DIR", "OPENCLAW_CONFIG_PATH", "OPENCLAW_GATEWAY_TOKEN", "OPENCLAW_TEST_GATEWAY_OVERRIDE_TOKEN", "OPENCLAW_TEST_RUNTIME_OVERRIDE_TOKEN", "OPENCLAW_TEST_MINIMAL_GATEWAY", "OPENCLAW_SKIP_CHANNELS", "OPENCLAW_SKIP_GMAIL_WATCHER", "OPENCLAW_SKIP_CRON", "OPENCLAW_SKIP_CANVAS_HOST", "OPENCLAW_SKIP_BROWSER_CONTROL_SERVER", "OPENCLAW_SKIP_PROVIDERS", "OPENCLAW_BUNDLED_PLUGINS_DIR", "OPENCLAW_DISABLE_BUNDLED_PLUGINS"];
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const baseKey = "agent:main:cron:proof:run:transient";
const childKey = `${baseKey}:heartbeat`;
const summary = "PR131462 quiet progress recorded by the real heartbeat tool";

function resetState() {
  resetConfigOverrides();
  clearRuntimeConfigSnapshot();
  clearConfigCache();
  clearSessionStoreCacheForTest();
  resetAgentEventsForTest({ preserveListeners: true });
  resetSystemEventsForTest();
  resetTaskRegistryForTests({ persist: false });
}

function containsAcceptedResponse(value: unknown): boolean {
  if (typeof value === "string") {
    try { return containsAcceptedResponse(JSON.parse(value)); } catch { return false; }
  }
  if (!value || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some(containsAcceptedResponse);
  const record = value as Record<string, unknown>;
  return (record.status === "accepted" && record.notify === false && record.summary === summary) || Object.values(record).some(containsAcceptedResponse);
}

function sendItem(response: ServerResponse, item: Record<string, unknown>, id: string) {
  const events = [
    { type: "response.output_item.added", output_index: 0, item: { ...item, status: "in_progress", ...(item.type === "function_call" ? { arguments: "" } : {}) } },
    ...(item.type === "function_call" ? [{ type: "response.function_call_arguments.delta", item_id: item.id, output_index: 0, delta: item.arguments }] : []),
    { type: "response.output_item.done", output_index: 0, item },
    { type: "response.completed", response: { id, status: "completed", output: [item], usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 } } },
  ];
  response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store" });
  response.end(`${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")}data: [DONE]\n\n`);
}

describe("PR131462 real cron quiet-heartbeat boundary", () => {
  beforeEach(resetState);
  afterEach(resetState);
  // Control first: the unchanged fixture must demonstrate retained owner-backed behavior.
  for (const seeded of [true, false]) {
    it(seeded ? "retains the durable owner outcome" : "completes without manufacturing a transient base owner", { timeout: 120_000 }, async () => {
      const envSnapshot = captureEnv(envKeys);
      const tempHome = tempDirs.make("pr131462-heartbeat-");
      const stateDir = path.join(tempHome, ".openclaw");
      const workspaceDir = path.join(tempHome, "workspace");
      const bundledDir = path.join(tempHome, "empty-bundled");
      const configPath = path.join(stateDir, "openclaw.json");
      const protocolErrors: string[] = [];
      let toolCallsSent = 0;
      let toolAccepted = false;
      let requestCount = 0;
      const callId = "call_pr131462_heartbeat";
      const providerServer = createServer((request, response) => {
        void (async () => {
          if (request.method !== "POST" || request.url !== "/v1/responses") {
            protocolErrors.push(`unexpected HTTP ${request.method} ${request.url}`);
            response.writeHead(404).end();
            return;
          }
          const chunks: Buffer[] = [];
          for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
          const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { tools?: unknown; input?: Array<Record<string, unknown>> };
          requestCount++;
          const result = body.input?.find((item) => item.type === "function_call_output" && item.call_id === callId);
          if (result) {
            const output = typeof result.output === "string" ? result.output : JSON.stringify(result.output);
            toolAccepted = /"status"\s*:\s*"accepted"/.test(output) && /"notify"\s*:\s*false/.test(output);
            if (!toolAccepted) protocolErrors.push(`tool result was not accepted: ${output.slice(0, 1000)}`);
            sendItem(response, { type: "message", id: "msg_pr131462", role: "assistant", status: "completed", content: [{ type: "output_text", text: "NO_REPLY", annotations: [] }] }, "resp_pr131462_final");
            return;
          }
          if (toolCallsSent > 0 || !JSON.stringify(body.tools).includes("heartbeat_respond")) {
            protocolErrors.push("missing heartbeat tool declaration or repeated initial request");
            response.writeHead(400).end("proof protocol mismatch");
            return;
          }
          toolCallsSent++;
          sendItem(response, { type: "function_call", id: "fc_pr131462", call_id: callId, name: "heartbeat_respond", arguments: JSON.stringify({ outcome: "progress", notify: false, summary }), status: "completed" }, "resp_pr131462_tool");
        })().catch((error: unknown) => {
          protocolErrors.push(String(error));
          if (!response.headersSent) response.writeHead(500);
          response.end("proof provider error");
        });
      });
      let gateway: Awaited<ReturnType<typeof startGatewayWithClient>> | undefined;
      try {
        await Promise.all([fs.mkdir(workspaceDir, { recursive: true }), fs.mkdir(bundledDir, { recursive: true }), fs.mkdir(stateDir, { recursive: true })]);
        await fs.writeFile(path.join(workspaceDir, "HEARTBEAT.md"), "Report quiet progress using heartbeat_respond.\n");
        // test/test-env.ts enables fast shortcuts globally; this Gateway proof needs the real runtime.
        for (const [key, value] of Object.entries({ OPENCLAW_TEST_FAST: "0", HOME: tempHome, OPENCLAW_STATE_DIR: stateDir, OPENCLAW_GATEWAY_TOKEN: "pr131462-test-token", OPENCLAW_SKIP_CHANNELS: "1", OPENCLAW_SKIP_GMAIL_WATCHER: "1", OPENCLAW_SKIP_CRON: "0", OPENCLAW_SKIP_CANVAS_HOST: "1", OPENCLAW_SKIP_BROWSER_CONTROL_SERVER: "1", OPENCLAW_SKIP_PROVIDERS: "1", OPENCLAW_BUNDLED_PLUGINS_DIR: bundledDir, OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1" })) setTestEnvValue(key, value);
        deleteTestEnvValue("OPENCLAW_CONFIG_PATH");
        deleteTestEnvValue("OPENCLAW_TEST_MINIMAL_GATEWAY");
        await new Promise<void>((resolve, reject) => { providerServer.once("error", reject); providerServer.listen(0, "127.0.0.1", resolve); });
        const address = providerServer.address();
        if (!address || typeof address === "string") throw new Error("provider did not bind");
        const provider = buildMockOpenAiResponsesProvider(`http://127.0.0.1:${address.port}/v1`, "proof-heartbeat-model");
        const cfg = {
          agents: { defaults: { workspace: workspaceDir, skipBootstrap: true, heartbeat: { every: "24h", session: "cron:proof:run:transient", isolatedSession: true, target: "none" }, model: { primary: provider.modelRef }, models: { [provider.modelRef]: { params: { transport: "sse", openaiWsWarmup: false } } } }, entries: { main: { default: true } } },
          messages: { visibleReplies: "message_tool" },
          models: { mode: "replace", providers: { [provider.providerId]: provider.config } },
          gateway: { auth: { mode: "token", token: "pr131462-test-token" } },
          plugins: { slots: { memory: "none" } },
        } satisfies OpenClawConfig;
        gateway = await startGatewayWithClient({ cfg, configPath, token: "pr131462-test-token", clientDisplayName: "pr131462-boundary-proof" });
        if (seeded) await replaceSessionEntry({ agentId: "main", sessionKey: baseKey }, { sessionId: "pr131462-durable-base", updatedAt: Date.now() });
        expect(Boolean(loadSessionEntry({ agentId: "main", sessionKey: baseKey, readConsistency: "latest" }))).toBe(seeded);
        const job = await gateway.client.request<{ id: string }>("cron.add", { name: "pr131462-quiet-heartbeat", enabled: true, schedule: { kind: "every", everyMs: 86400000 }, sessionTarget: "main", wakeMode: "now", payload: { kind: "systemEvent", text: "PR131462: record quiet progress using heartbeat_respond with notify false." } });
        const run = await gateway.client.request<{ ok: boolean; enqueued: boolean; runId: string }>("cron.run", { id: job.id, mode: "force" });
        expect(run).toMatchObject({ ok: true, enqueued: true, runId: expect.any(String) });
        let terminal: { runId?: string; status?: string; error?: string } | undefined;
        await expect.poll(async () => {
          const history = await gateway!.client.request<{ entries: Array<{ runId?: string; status?: string; error?: string }> }>("cron.runs", { id: job.id, runId: run.runId, limit: 1 });
          terminal = history.entries.find((entry) => entry.runId === run.runId);
          return terminal?.status;
        }, { timeout: 60000, interval: 100 }).toBeDefined();
        const owner = loadSessionEntry({ agentId: "main", sessionKey: baseKey, readConsistency: "latest" });
        const child = loadSessionEntry({ agentId: "main", sessionKey: childKey, readConsistency: "latest" });
        const db = openOpenClawAgentDatabase({ agentId: "main" }).db;
        const outcomeCount = Number(db.prepare("SELECT COUNT(*) AS n FROM heartbeat_outcomes WHERE session_key = ?").get(baseKey)?.n ?? 0);
        const nodeCount = Number(db.prepare("SELECT COUNT(*) AS n FROM session_nodes WHERE session_key = ?").get(baseKey)?.n ?? 0);
        const transcript = child?.sessionId ? await readSessionMessagesAsync({ agentId: "main", sessionEntry: child, sessionId: child.sessionId, sessionKey: childKey }, { mode: "full", reason: "PR131462 boundary proof" }) : [];
        const transcriptTool = JSON.stringify(transcript).includes("heartbeat_respond");
        const transcriptAccepted = containsAcceptedResponse(transcript);
        const toolExecuted = transcriptTool && (toolAccepted || transcriptAccepted);
        const claim1 = claimHeartbeatOutcomeForRun({ agentId: "main", sessionKey: baseKey, runId: "proof-reader-1" });
        const retry = claimHeartbeatOutcomeForRun({ agentId: "main", sessionKey: baseKey, runId: "proof-reader-1" });
        const claim2 = claimHeartbeatOutcomeForRun({ agentId: "main", sessionKey: baseKey, runId: "proof-reader-2" });
        process.stdout.write(`HEARTBEAT_PROOF ${JSON.stringify({ case: seeded ? "durable" : "transient", status: terminal?.status, error: terminal?.error, terminal, ownerExists: Boolean(owner), childExists: Boolean(child), nodeCount, outcomeCount, toolExecuted, claimPreserved: seeded ? Boolean(claim1 && retry && JSON.stringify(claim1) === JSON.stringify(retry) && !claim2) : !claim1 && !retry && !claim2, toolCallsSent, toolAccepted, transcriptAccepted, transcriptTool, requestCount, protocolErrors, claimBehavior: { first: Boolean(claim1), retry: Boolean(retry), otherRun: Boolean(claim2) } })}\n`);
        expect(protocolErrors).toEqual([]);
        expect(toolCallsSent).toBe(1);
        expect(toolExecuted).toBe(true);
        expect(child?.heartbeatIsolatedBaseSessionKey).toBe(baseKey);
        expect(transcriptTool).toBe(true);
        expect(Boolean(owner)).toBe(seeded);
        expect(nodeCount).toBe(seeded ? 1 : 0);
        expect(outcomeCount).toBe(seeded ? 1 : 0);
        if (seeded) {
          expect(owner?.sessionId).toBe("pr131462-durable-base");
          expect(claim1).toMatchObject({ sessionKey: baseKey, runSessionKey: childKey, outcome: "progress", summary });
          expect(retry).toEqual(claim1);
        } else {
          expect(claim1).toBeUndefined();
          expect(retry).toBeUndefined();
        }
        expect(claim2).toBeUndefined();
        expect(terminal).toMatchObject({ runId: run.runId, status: "ok" });
        expect(terminal?.error).toBeUndefined();
      } finally {
        if (gateway) {
          await disconnectGatewayClient(gateway.client);
          await gateway.server.close({ reason: "PR131462 proof complete" });
        }
        providerServer.closeAllConnections();
        if (providerServer.listening) await new Promise<void>((resolve) => providerServer.close(() => resolve()));
        envSnapshot.restore();
      }
    });
  }
});
