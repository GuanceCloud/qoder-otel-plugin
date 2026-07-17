import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import { resolveConfig } from "./qoder-config.js";
import { buildQoderMetrics } from "./qoder-metrics.js";
import { qoderMetricsToOtlpProtobufRequest, qoderSpansToOtlpProtobufRequest } from "./qoder-otlp.js";
import { resolveQoderLayout } from "./qoder-paths.js";
import { encodeExportMetricsServiceRequest, encodeExportTraceServiceRequest } from "./proto.js";
import { clipValue, readStdin, toText, truncate } from "./qoder-utils.js";

const execFileAsync = promisify(execFile);
const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const QODER_LAYOUT = resolveQoderLayout({ env: process.env, pluginRoot: PLUGIN_ROOT });
const DEBUG_JSONL = QODER_LAYOUT.debugJsonlFile;
const HOOK_LOG = QODER_LAYOUT.hookLogFile;
const STATE_DIR = QODER_LAYOUT.stateDir;
const UPLOAD_MARKER_DIR = path.join(STATE_DIR, "uploads");
const QODER_GTRACE_CONFIG = QODER_LAYOUT.globalConfigFile;
const PLUGIN_VERSION = "0.1.1";
const UPLOAD_CLAIM_TTL_MS = 10 * 60 * 1000;

function randomTraceId() {
  return crypto.randomBytes(16).toString("hex");
}

function randomSpanId() {
  return crypto.randomBytes(8).toString("hex");
}

function nsFromIso(value) {
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return undefined;
  return BigInt(ms) * 1_000_000n;
}

function nsFromMs(value) {
  if (!Number.isFinite(value)) return undefined;
  return BigInt(Math.trunc(value)) * 1_000_000n;
}

function nowNs() {
  return BigInt(Date.now()) * 1_000_000n;
}

function nsString(value) {
  return typeof value === "bigint" ? value.toString() : undefined;
}

function safeName(value) {
  return String(value || "unknown").replace(/[^A-Za-z0-9_.-]/g, "_");
}

function safeJsonParse(value, fallback = undefined) {
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function stableStringify(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
}

function numberValue(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string" || !value.trim()) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function perCallUsage(usage = {}) {
  const promptTokens = numberValue(usage.prompt_tokens);
  const cachedTokens = numberValue(usage.cached_tokens) ?? 0;
  return {
    inputTokens: promptTokens,
    outputTokens: numberValue(usage.completion_tokens),
    cachedTokens,
    promptTokens,
  };
}

function extractCredits(...sources) {
  const creditKeys = new Set([
    "credits",
    "credit",
    "credit_usage",
    "credits_usage",
    "used_credits",
    "usage_credits",
    "cost_credits",
    "credit_cost",
    "cost",
  ]);
  const queue = sources.filter((source) => source && typeof source === "object");
  const seen = new Set();

  while (queue.length > 0) {
    const current = queue.shift();
    if (!current || typeof current !== "object" || seen.has(current)) continue;
    seen.add(current);

    for (const [key, value] of Object.entries(current)) {
      const normalized = key.replace(/[A-Z]/g, (char) => `_${char.toLowerCase()}`).toLowerCase();
      if (creditKeys.has(normalized)) {
        const numeric = numberValue(value);
        if (numeric !== undefined) return numeric;
      }
      if (value && typeof value === "object") queue.push(value);
    }
  }

  return undefined;
}

function textOfContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((item) => {
      if (!item || typeof item !== "object") return "";
      if (typeof item.text === "string") return item.text;
      if (typeof item.thinking === "string") return item.thinking;
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

function firstTextContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return undefined;
  const item = content.find((entry) => entry?.type === "text" && typeof entry.text === "string");
  return item?.text;
}

function firstThinkingContent(content) {
  if (!Array.isArray(content)) return undefined;
  const item = content.find((entry) => entry?.type === "thinking" && typeof entry.thinking === "string");
  return item?.thinking;
}

function messageParts(content) {
  const parts = [];
  for (const item of contentParts(content)) {
    if (item.type === "text" && typeof item.text === "string") {
      parts.push({ type: "text", text: item.text });
    } else if (item.type === "thinking" && typeof item.thinking === "string") {
      parts.push({ type: "reasoning", text: item.thinking });
    } else if (item.type === "tool_use") {
      parts.push({
        type: "tool_call",
        id: item.id,
        name: item.name,
        arguments: item.input,
      });
    }
  }
  return parts;
}

function toolResultMessages(content) {
  const messages = [];
  for (const item of contentParts(content)) {
    if (item.type === "tool_result" && typeof item.content === "string") {
      messages.push({
        role: "tool",
        tool_call_id: item.tool_use_id,
        content: item.content,
      });
    }
  }
  return messages;
}

function contentParts(content) {
  if (!Array.isArray(content)) return [];
  return content.filter((entry) => entry && typeof entry === "object");
}

function isHumanUserMessage(event) {
  const content = event?.message?.content;
  if (typeof content === "string" && content.trim()) return true;
  const parts = contentParts(content);
  if (parts.length === 0) return false;
  return parts.some((part) => part.type === "text" && typeof part.text === "string" && part.text.trim());
}

async function appendJsonl(file, record) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.appendFile(file, `${JSON.stringify(record)}\n`, "utf-8");
}

async function appendLog(message, extra = {}) {
  await appendJsonl(HOOK_LOG, { ts: new Date().toISOString(), message, ...extra }).catch(() => {});
}

async function readTranscript(transcriptPath) {
  const raw = await fs.readFile(transcriptPath, "utf-8");
  return raw
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => safeJsonParse(line))
    .filter(Boolean);
}

async function readHookEvents(sessionId) {
  const raw = await fs.readFile(DEBUG_JSONL, "utf-8").catch(() => "");
  if (!raw) return [];
  return raw
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => safeJsonParse(line))
    .filter((entry) => entry?.payload?.session_id === sessionId);
}

function statePath(sessionId) {
  return path.join(STATE_DIR, `${safeName(sessionId)}.json`);
}

async function loadState(sessionId) {
  return safeJsonParse(await fs.readFile(statePath(sessionId), "utf-8").catch(() => "{}"), {});
}

async function saveState(sessionId, state) {
  await fs.mkdir(STATE_DIR, { recursive: true });
  await fs.writeFile(statePath(sessionId), JSON.stringify(state, null, 2), "utf-8");
}

function uploadMarkerPath(sessionId, fingerprint) {
  return path.join(UPLOAD_MARKER_DIR, safeName(sessionId), safeName(fingerprint));
}

async function claimUpload(sessionId, fingerprint) {
  const marker = uploadMarkerPath(sessionId, fingerprint);
  try {
    await fs.mkdir(marker, { recursive: false });
    await fs.writeFile(path.join(marker, "started.json"), JSON.stringify({
      session_id: sessionId,
      fingerprint,
      startedAt: new Date().toISOString(),
    }, null, 2), "utf-8");
    return { claimed: true, marker };
  } catch (error) {
    if (error?.code === "ENOENT") {
      await fs.mkdir(path.dirname(marker), { recursive: true });
      return claimUpload(sessionId, fingerprint);
    }
    if (error?.code === "EEXIST") {
      const uploaded = await fs.stat(path.join(marker, "uploaded.json")).catch(() => undefined);
      if (uploaded) return { claimed: false, marker };

      const started = await fs.stat(path.join(marker, "started.json")).catch(() => undefined);
      if (started && Date.now() - started.mtimeMs > UPLOAD_CLAIM_TTL_MS) {
        await releaseUploadClaim(marker);
        return claimUpload(sessionId, fingerprint);
      }

      return { claimed: false, marker };
    }
    throw error;
  }
}

async function completeUploadMarker(marker, details) {
  await fs.writeFile(path.join(marker, "uploaded.json"), JSON.stringify({
    ...details,
    uploadedAt: new Date().toISOString(),
  }, null, 2), "utf-8").catch(() => {});
}

async function releaseUploadClaim(marker) {
  await fs.rm(marker, { recursive: true, force: true }).catch(() => {});
}

function eventTimeNs(event, fallback) {
  return nsFromIso(event?.timestamp) ?? fallback ?? nowNs();
}

function resource(config, hookInput) {
  const version = hookInput?.extra?.version ?? process.env.QODER_HOOK_VERSION ?? "1.5.0";
  return {
    "service.name": "gtrace-qoder",
    "service.namespace": "ai-agent",
    "telemetry.sdk.language": "nodejs",
    "telemetry.sdk.name": "gtrace",
    "telemetry.sdk.version": PLUGIN_VERSION,
    host: os.hostname(),
    "gen_ai.system": "qoder",
    "gen_ai.agent.name": "Qoder",
    "gen_ai.agent.version": version,
    agent_type: "assistant",
    agent_source: "qoder",
    agent_runtime: "qoder",
    ...(config.environment ? { "deployment.environment": config.environment } : {}),
    ...(config.user_id ? { "enduser.id": config.user_id } : {}),
    ...(config.resourceAttributes ?? {}),
  };
}

function scope() {
  return {
    name: "qoder-otel-plugin",
    version: PLUGIN_VERSION,
  };
}

function makeSpan({ traceId, spanId, parentId, name, startNs, endNs, attributes, status }) {
  return {
    trace_id: traceId,
    span_id: spanId,
    parent_id: parentId,
    name,
    kind: "SPAN_KIND_INTERNAL",
    start_time_unix_nano: nsString(startNs),
    end_time_unix_nano: nsString(endNs && endNs > startNs ? endNs : startNs + 1_000_000n),
    attributes,
    status: status ?? { code: "STATUS_CODE_OK" },
  };
}

function previewFields(input, output, maxChars) {
  const inputText = toText(input);
  const outputText = toText(output);
  return {
    input_preview: truncate(inputText, maxChars),
    input_length: inputText.length,
    output_preview: truncate(outputText, maxChars),
    output_length: outputText.length,
  };
}

function transcriptFingerprint(events) {
  const last = events.at(-1);
  return crypto.createHash("sha256").update(JSON.stringify({
    count: events.length,
    lastUuid: last?.uuid,
    lastTs: last?.timestamp,
  })).digest("hex");
}

function collectLlmEvents(events, tokenRows = []) {
  const blocks = [];
  let current = [];
  let startNs;
  let inputMessages = [];

  function flush() {
    if (current.length === 0) return;
    const endNs = eventTimeNs(current.at(-1), startNs);
    const parts = current.flatMap((event) => messageParts(event.message?.content));
    const text = parts
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .filter(Boolean)
      .join("\n");
    const thinking = parts
      .filter((part) => part.type === "reasoning")
      .map((part) => part.text)
      .filter(Boolean)
      .join("\n");
    const toolCalls = parts.filter((part) => part.type === "tool_call");
    blocks.push({
      startNs,
      endNs,
      text,
      thinking,
      inputMessages,
      toolCalls,
      outputKind: toolCalls.length > 0 ? "tool_call" : "text",
      outputMessages: [{
        role: "assistant",
        content: parts,
      }],
    });
    current = [];
    inputMessages = [];
  }

  for (const event of events) {
    if (event.type === "assistant") {
      if (current.length === 0) startNs ??= eventTimeNs(event);
      current.push(event);
      continue;
    }

    flush();
    inputMessages = inputMessages.concat(toolResultMessages(event.message?.content));
    startNs = eventTimeNs(event);
  }
  flush();

  return blocks.map((block, index) => ({
    ...block,
    tokenInfo: tokenRows[index],
  }));
}

function parseTurn(events, hookInput, tokenInfo, hookEvents = []) {
  const userEvents = events.filter((event) => event.type === "user");
  const assistantEvents = events.filter((event) => event.type === "assistant");
  const progressEvents = events.filter((event) => event.type === "progress");
  const lastUser = [...userEvents].reverse().find(isHumanUserMessage);
  const lastAssistantText = [...assistantEvents].reverse().find((event) => firstTextContent(event.message?.content));
  const lastAssistantThinking = [...assistantEvents].reverse().find((event) => firstThinkingContent(event.message?.content));
  const firstNs = eventTimeNs(lastUser, nsFromMs(Date.now()));
  const endNs = eventTimeNs(lastAssistantText ?? assistantEvents.at(-1) ?? events.at(-1), firstNs + 1_000_000n);
  const turnRequestId = tokenInfo?.latest?.requestId ?? tokenInfo?.rows?.find((row) => row?.requestId)?.requestId;
  return {
    sessionId: hookInput.session_id,
    requestId: turnRequestId,
    cwd: hookInput.cwd,
    transcriptPath: hookInput.transcript_path,
    prompt: textOfContent(lastUser?.message?.content) || hookInput.prompt,
    output: firstTextContent(lastAssistantText?.message?.content) ?? hookInput.last_assistant_message,
    thinking: firstThinkingContent(lastAssistantThinking?.message?.content),
    startNs: firstNs,
    endNs,
    userEvents,
    assistantEvents,
    toolEvents: collectToolEvents(events, hookEvents),
    llmEvents: collectLlmEvents(events, tokenInfo?.rows ?? []),
    progressEvents,
    tokenInfo,
  };
}

function hookToolKey(name, input) {
  return `${name ?? "unknown"}:${stableStringify(input ?? null)}`;
}

function buildToolTimingIndex(hookEvents) {
  const pending = new Map();
  const completed = new Map();

  for (const event of hookEvents) {
    const payload = event?.payload;
    const toolName = payload?.tool_name;
    const toolInput = payload?.tool_input;
    if (!toolName) continue;
    const key = hookToolKey(toolName, toolInput);

    if (payload?.hook_event_name === "PreToolUse") {
      const queue = pending.get(key) ?? [];
      queue.push({ requestNs: nsFromIso(payload?.extra?.request_time) });
      pending.set(key, queue);
      continue;
    }

    if (payload?.hook_event_name === "PostToolUse" || payload?.hook_event_name === "PostToolUseFailure") {
      const queue = pending.get(key) ?? [];
      const current = queue.shift() ?? {};
      pending.set(key, queue);
      const matched = {
        requestNs: current.requestNs ?? nsFromIso(payload?.extra?.request_time),
        responseNs: nsFromIso(payload?.extra?.response_time),
        isError: payload?.hook_event_name === "PostToolUseFailure",
      };
      const out = completed.get(key) ?? [];
      out.push(matched);
      completed.set(key, out);
    }
  }

  return completed;
}

function collectToolEvents(events, hookEvents = []) {
  const calls = [];
  const results = new Map();
  const timingIndex = buildToolTimingIndex(hookEvents);

  for (const event of events) {
    for (const part of contentParts(event.message?.content)) {
      if (part.type === "tool_use") {
        calls.push({
          id: part.id,
          name: part.name,
          input: part.input,
          startNs: eventTimeNs(event),
        });
      } else if (part.type === "tool_result") {
        results.set(part.tool_use_id, {
          id: part.tool_use_id,
          result: part.content,
          isError: part.is_error === true,
          endNs: eventTimeNs(event),
        });
      }
    }
  }

  return calls.map((call) => {
    const key = hookToolKey(call.name, call.input);
    const timingQueue = timingIndex.get(key) ?? [];
    const timing = timingQueue.shift() ?? {};
    return {
      ...call,
      ...(results.get(call.id) ?? {}),
      requestNs: timing.requestNs,
      responseNs: timing.responseNs,
      isError: timing.isError ?? results.get(call.id)?.isError ?? false,
    };
  });
}

function skillNameFromToolEvent(event) {
  if (event?.name !== "Skill") return undefined;
  const skill = event.input?.skill;
  return typeof skill === "string" && skill.trim() ? skill.trim() : undefined;
}

function skillPath(skillName) {
  if (!skillName) return undefined;
  return path.join(QODER_LAYOUT.skillsDir, skillName, "SKILL.md");
}

async function resolveTokenDbPath(sessionId) {
  const db = QODER_LAYOUT.localDbPath;
  if (!db) {
    await appendLog("token db unavailable", {
      session_id: sessionId,
      reason: "no_db_path",
      candidates: QODER_LAYOUT.localDbCandidates,
    });
    return undefined;
  }

  try {
    await fs.access(db);
    return db;
  } catch (error) {
    await appendLog("token db unavailable", {
      session_id: sessionId,
      db,
      candidates: QODER_LAYOUT.localDbCandidates,
      error: error.message,
    });
    return undefined;
  }
}

async function queryLatestTokenInfo(sessionId) {
  const db = await resolveTokenDbPath(sessionId);
  if (!db) return {};
  const script = `
import json, sqlite3, sys
db, session = sys.argv[1:3]
con = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
row = con.execute("""
select request_id, token_info, model_info, extra, gmt_create
from chat_message
where session_id = ? and role = 'assistant' and token_info != ''
order by gmt_create desc
limit 1
""", (session,)).fetchone()
con.close()
if row:
    print(json.dumps({"request_id": row[0], "token_info": row[1], "model_info": row[2], "extra": row[3], "gmt_create": row[4]}))
`;
  try {
    const { stdout } = await execFileAsync("python3", ["-c", script, db, sessionId], { timeout: 3000 });
    const row = safeJsonParse(stdout.trim());
    if (!row) return {};
    const usage = safeJsonParse(row.token_info, {});
    const model = safeJsonParse(row.model_info, {});
    const extra = safeJsonParse(row.extra, {});
    return {
      requestId: row.request_id,
      usage,
      model,
      extra,
      credits: extractCredits(usage, model, extra),
      gmtCreate: row.gmt_create,
    };
  } catch (error) {
    await appendLog("token query failed", {
      session_id: sessionId,
      db,
      candidates: QODER_LAYOUT.localDbCandidates,
      error: error.message,
    });
    return {};
  }
}

async function queryTokenInfo(sessionId) {
  const db = await resolveTokenDbPath(sessionId);
  if (!db) return { rows: [], latest: {} };
  const script = `
import json, sqlite3, sys
db, session = sys.argv[1:3]
con = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
rows = con.execute("""
select request_id, token_info, model_info, extra, gmt_create
from chat_message
where session_id = ? and role = 'assistant' and token_info != ''
order by gmt_create asc
""", (session,)).fetchall()
con.close()
print(json.dumps([
    {"request_id": row[0], "token_info": row[1], "model_info": row[2], "extra": row[3], "gmt_create": row[4]}
    for row in rows
]))
`;
  try {
    const { stdout } = await execFileAsync("python3", ["-c", script, db, sessionId], { timeout: 3000 });
    const rows = safeJsonParse(stdout.trim(), []);
    const parsedRows = rows.map((row) => {
      const usage = safeJsonParse(row.token_info, {});
      const model = safeJsonParse(row.model_info, {});
      const extra = safeJsonParse(row.extra, {});
      return {
        requestId: row.request_id,
        usage,
        model,
        extra,
        credits: extractCredits(usage, model, extra),
        gmtCreate: row.gmt_create,
      };
    });
    return {
      rows: parsedRows,
      latest: parsedRows.at(-1) ?? {},
    };
  } catch (error) {
    await appendLog("token query failed", {
      session_id: sessionId,
      db,
      candidates: QODER_LAYOUT.localDbCandidates,
      error: error.message,
    });
    return { rows: [], latest: {} };
  }
}

function buildSpans(config, hookInput, turn) {
  const traceId = randomTraceId();
  const rootId = randomSpanId();
  const assistantId = randomSpanId();
  const agentVersion = hookInput?.extra?.version ?? process.env.QODER_HOOK_VERSION ?? "1.5.0";
  const turnId = turn.requestId;
  const rootAttrs = {
    "span.kind": "internal",
    "gen_ai.operation.name": "invoke_agent",
    "gen_ai.system": "qoder",
    "gen_ai.agent.name": "Qoder",
    "gen_ai.agent.version": agentVersion,
    "gen_ai.conversation.id": turn.sessionId,
    ...(turnId ? { "gen_ai.turn.id": turnId } : {}),
    ...(turnId ? { turn_id: turnId } : {}),
    session_id: turn.sessionId,
    status: "ok",
    final_status: "completed",
    tool_count: turn.toolEvents.length,
    "qoder.session_id": turn.sessionId,
    ...(turnId ? { "qoder.request_id": turnId } : {}),
    "qoder.cwd": turn.cwd,
    "qoder.transcript_path": turn.transcriptPath,
    "qoder.hook_source": process.env.QODER_HOOK_SOURCE,
    "qoder.user_id": hookInput.extra?.user?.uid ?? process.env.QODER_USER_ID,
    "qoder.user_name": hookInput.extra?.user?.name ?? process.env.QODER_USER_NAME,
    ...previewFields(turn.prompt, turn.output, config.max_chars),
    "gen_ai.input.messages": clipValue([{ role: "user", content: turn.prompt }], config.max_chars),
    "gen_ai.output.messages": clipValue([{ role: "assistant", content: turn.output }], config.max_chars),
    "gen_ai.response.finish_reasons": ["stop"],
  };
  const latestTokenInfo = turn.tokenInfo?.latest ?? turn.tokenInfo ?? {};
  const usage = latestTokenInfo?.usage ?? {};
  const model = latestTokenInfo?.model ?? {};
  const credits = latestTokenInfo?.credits;
  if (credits !== undefined) {
    rootAttrs["gen_ai.usage.credits"] = credits;
  }
  const spans = [
    makeSpan({
      traceId,
      spanId: rootId,
      name: "invoke_agent",
      startNs: turn.startNs,
      endNs: turn.endNs,
      attributes: rootAttrs,
    }),
  ];
  const toolCallToLlmSpanId = new Map();

  for (const [index, event] of turn.llmEvents.entries()) {
    const tokenInfo = event.tokenInfo ?? {};
    const eventUsage = tokenInfo.usage ?? {};
    const usageValues = perCallUsage(eventUsage);
    const eventModel = tokenInfo.model ?? model;
    const eventCredits = tokenInfo.credits;
    const llmId = randomSpanId();
    for (const toolCall of event.toolCalls) {
      if (toolCall.id) toolCallToLlmSpanId.set(toolCall.id, llmId);
    }

    spans.push(makeSpan({
      traceId,
      spanId: llmId,
      parentId: rootId,
      name: "llm",
      startNs: event.startNs,
      endNs: event.endNs,
      attributes: {
        "span.kind": "client",
        "gen_ai.operation.name": "chat",
        "gen_ai.system": "qoder",
        "gen_ai.agent.name": "Qoder",
        "gen_ai.agent.version": agentVersion,
        "gen_ai.conversation.id": turn.sessionId,
        ...(turnId ? { "gen_ai.turn.id": turnId } : {}),
        ...(turnId ? { turn_id: turnId } : {}),
        session_id: turn.sessionId,
        status: "ok",
        "gen_ai.request.model": eventModel.model_key,
        "gen_ai.response.model": eventModel.model_key,
        "gen_ai.usage.input_tokens": usageValues.inputTokens,
        "gen_ai.usage.output_tokens": usageValues.outputTokens,
        "gen_ai.usage.cache_read.input_tokens": usageValues.cachedTokens,
        ...(eventCredits !== undefined ? { "gen_ai.usage.credits": eventCredits } : {}),
        ...(turnId ? { "qoder.request_id": turnId } : {}),
        "qoder.usage.prompt_tokens": usageValues.promptTokens,
        "qoder.max_input_tokens": eventUsage.max_input_tokens,
        "qoder.llm.sequence": index + 1,
        "gen_ai.input.messages": clipValue(
          index === 0
            ? [{ role: "user", content: turn.prompt }, ...event.inputMessages]
            : event.inputMessages,
          config.max_chars,
        ),
        "gen_ai.output.messages": clipValue(event.outputMessages, config.max_chars),
        "gen_ai.output.type": event.outputKind === "tool_call" ? "tool_call" : "text",
        output_kind: event.outputKind,
        ...(event.thinking ? { "gen_ai.output.thinking": clipValue(event.thinking, config.max_chars) } : {}),
      },
    }));
  }

  for (const event of turn.toolEvents) {
    const startNs = event.requestNs ?? event.startNs ?? turn.startNs;
    const endNs = event.responseNs ?? event.endNs ?? startNs + 1_000_000n;
    const toolSpanId = randomSpanId();
    spans.push(makeSpan({
      traceId,
      spanId: toolSpanId,
      parentId: rootId,
      name: `tool:${event.name ?? "unknown"}`,
      startNs,
      endNs,
      attributes: {
        "span.kind": "internal",
        "gen_ai.operation.name": "execute_tool",
        "gen_ai.system": "qoder",
        "gen_ai.agent.name": "Qoder",
        "gen_ai.agent.version": agentVersion,
        "gen_ai.conversation.id": turn.sessionId,
        ...(turnId ? { "gen_ai.turn.id": turnId } : {}),
        ...(turnId ? { turn_id: turnId } : {}),
        session_id: turn.sessionId,
        status: event.isError ? "error" : "ok",
        "gen_ai.tool.name": event.name,
        "gen_ai.tool.call.id": event.id,
        "gen_ai.tool.call.arguments": clipValue(event.input, config.max_chars),
        "gen_ai.tool.call.result": clipValue(event.result, config.max_chars),
        ...(turnId ? { "qoder.request_id": turnId } : {}),
        tool_result_status: event.isError ? "error" : "success",
        "triggered_by.llm_span_id": toolCallToLlmSpanId.get(event.id),
      },
      status: event.isError
        ? { code: "STATUS_CODE_ERROR", message: "tool error" }
        : { code: "STATUS_CODE_OK" },
    }));

    const skillName = skillNameFromToolEvent(event);
    if (skillName) {
      const status = event.isError ? "error" : "ok";
      spans.push(makeSpan({
        traceId,
        spanId: randomSpanId(),
        parentId: toolSpanId,
        name: `skill:${skillName}`,
        startNs,
        endNs,
        attributes: {
          "span.kind": "internal",
          "gen_ai.operation.name": "skill",
          "gen_ai.system": "qoder",
          "gen_ai.agent.name": "Qoder",
          "gen_ai.agent.version": agentVersion,
          "gen_ai.conversation.id": turn.sessionId,
          ...(turnId ? { "gen_ai.turn.id": turnId } : {}),
          ...(turnId ? { turn_id: turnId } : {}),
          session_id: turn.sessionId,
          status,
          "gen_ai.skill.name": skillName,
          "gen_ai.skill.path": skillPath(skillName),
          "gen_ai.skill.source.type": "qoder",
          "gen_ai.skill.result.status": event.isError ? "error" : "completed",
          ...(turnId ? { "qoder.request_id": turnId } : {}),
          "skill.name": skillName,
          "skill.path": skillPath(skillName),
          skill_call_id: event.id,
        },
        status: event.isError
          ? { code: "STATUS_CODE_ERROR", message: "skill error" }
          : { code: "STATUS_CODE_OK" },
      }));
    }
  }

  spans.push(makeSpan({
    traceId,
    spanId: assistantId,
    parentId: rootId,
    name: "assistant",
    startNs: turn.endNs,
    endNs: turn.endNs,
    attributes: {
      "span.kind": "internal",
      "gen_ai.system": "qoder",
      "gen_ai.agent.name": "Qoder",
      "gen_ai.agent.version": agentVersion,
      "gen_ai.conversation.id": turn.sessionId,
      ...(turnId ? { "gen_ai.turn.id": turnId } : {}),
      ...(turnId ? { turn_id: turnId } : {}),
      session_id: turn.sessionId,
      status: "ok",
      "gen_ai.output.type": "text",
      output_kind: "text",
      ...(turnId ? { "qoder.request_id": turnId } : {}),
      "gen_ai.output.messages": clipValue([{ role: "assistant", content: turn.output }], config.max_chars),
    },
  }));

  for (const span of spans) {
    span.resource = resource(config, hookInput);
    span.scope = scope();
  }
  return spans;
}

function resolveOtelUrl(endpoint, pathName) {
  const normalizedPath = String(pathName ?? "").trim().replace(/^\/+/, "").replace(/\/+$/, "");
  if (!normalizedPath) return endpoint;
  const endpointWithoutQueryOrFragment = endpoint.split(/[?#]/, 1)[0] ?? endpoint;
  const escapedPath = normalizedPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (new RegExp(`/${escapedPath}$`, "i").test(endpointWithoutQueryOrFragment)) return endpoint;
  return `${endpoint}/${normalizedPath}`;
}

function authHeader(config) {
  if (!config.public_key && !config.secret_key) return undefined;
  return `Basic ${Buffer.from(`${config.public_key ?? ""}:${config.secret_key ?? ""}`).toString("base64")}`;
}

function redactHeaders(headers = {}) {
  const redacted = {};
  for (const [key, value] of Object.entries(headers)) {
    if (/^(authorization|x-token|token|api[-_]?key)$/i.test(key)) {
      redacted[key] = "<redacted>";
    } else {
      redacted[key] = value;
    }
  }
  return redacted;
}

async function uploadTraces(config, spans) {
  const url = config.otel_traces_url || resolveOtelUrl(config.endpoint ?? config.base_url, config.tracePath);
  const headers = { ...(config.headers ?? {}), "content-type": "application/x-protobuf" };
  const auth = authHeader(config);
  if (auth && !headers.authorization && !headers.Authorization) headers.authorization = auth;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.timeout_ms ?? 25_000);
  const startedAt = Date.now();
  const body = encodeExportTraceServiceRequest(qoderSpansToOtlpProtobufRequest(spans));
  await appendLog("upload traces start", {
    url,
    span_count: spans.length,
    body_bytes: body.length,
    timeout_ms: config.timeout_ms ?? 25_000,
    headers: redactHeaders(headers),
  });
  try {
    const response = await fetch(url, { method: "POST", headers, body, signal: controller.signal });
    const responseBody = await response.text().catch(() => "");
    const durationMs = Date.now() - startedAt;
    if (!response.ok) {
      await appendLog("upload traces http_error", {
        url,
        status: response.status,
        duration_ms: durationMs,
        response_body: responseBody.slice(0, 2000),
      });
      throw new Error(`HTTP ${response.status} ${responseBody}`);
    }
    await appendLog("upload traces success", {
      url,
      status: response.status,
      duration_ms: durationMs,
      response_body: responseBody.slice(0, 2000),
    });
    return { status: response.status, body: responseBody, duration_ms: durationMs, body_bytes: body.length };
  } catch (error) {
    await appendLog("upload traces exception", {
      url,
      duration_ms: Date.now() - startedAt,
      error: error?.message ?? String(error),
      name: error?.name,
    });
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function uploadMetrics(config, metrics) {
  if (!metrics.length) {
    await appendLog("upload metrics skipped", { reason: "empty_metrics" });
    return { skipped: true, reason: "empty_metrics" };
  }
  const url = config.otel_metrics_url || resolveOtelUrl(config.endpoint ?? config.base_url, config.metricsPath);
  const headers = { ...(config.headers ?? {}), "content-type": "application/x-protobuf" };
  const auth = authHeader(config);
  if (auth && !headers.authorization && !headers.Authorization) headers.authorization = auth;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.timeout_ms ?? 25_000);
  const startedAt = Date.now();
  const body = encodeExportMetricsServiceRequest(qoderMetricsToOtlpProtobufRequest(metrics));
  await appendLog("upload metrics start", {
    url,
    metric_points: metrics.length,
    metric_names: [...new Set(metrics.map((metric) => metric.name))],
    body_bytes: body.length,
    timeout_ms: config.timeout_ms ?? 25_000,
    headers: redactHeaders(headers),
  });
  try {
    const response = await fetch(url, { method: "POST", headers, body, signal: controller.signal });
    const responseBody = await response.text().catch(() => "");
    const durationMs = Date.now() - startedAt;
    if (!response.ok) {
      await appendLog("upload metrics http_error", {
        url,
        status: response.status,
        duration_ms: durationMs,
        response_body: responseBody.slice(0, 2000),
      });
      throw new Error(`HTTP ${response.status} ${responseBody}`);
    }
    await appendLog("upload metrics success", {
      url,
      status: response.status,
      duration_ms: durationMs,
      response_body: responseBody.slice(0, 2000),
    });
    return { status: response.status, body: responseBody, duration_ms: durationMs, body_bytes: body.length };
  } catch (error) {
    await appendLog("upload metrics exception", {
      url,
      duration_ms: Date.now() - startedAt,
      error: error?.message ?? String(error),
      name: error?.name,
    });
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function runHook() {
  const config = resolveConfig({ cwd: PLUGIN_ROOT, configFile: QODER_GTRACE_CONFIG });
  const hookInput = await readStdin();
  await appendJsonl(DEBUG_JSONL, {
    ts: Date.now() / 1000,
    event_arg: hookInput.hook_event_name,
    cwd: process.cwd(),
    env: Object.fromEntries(Object.entries(process.env).filter(([key]) => key.startsWith("QODER_"))),
    payload: hookInput,
  }).catch(() => {});

  if (hookInput.hook_event_name !== "Stop") {
    await appendLog("non-stop hook recorded", { event: hookInput.hook_event_name });
    return;
  }
  if (!config.enabled) {
    await appendLog("gtrace disabled");
    return;
  }
  if (!hookInput.transcript_path || !hookInput.session_id) {
    await appendLog("missing transcript/session", { hookInput });
    return;
  }

  const events = await readTranscript(hookInput.transcript_path);
  const fingerprint = transcriptFingerprint(events);
  const state = await loadState(hookInput.session_id);
  if (state.lastUploadedFingerprint === fingerprint) {
    await appendLog("skipped duplicate upload", { session_id: hookInput.session_id, fingerprint });
    return;
  }

  const claim = await claimUpload(hookInput.session_id, fingerprint);
  if (!claim.claimed) {
    await appendLog("skipped duplicate upload marker", {
      session_id: hookInput.session_id,
      fingerprint,
      marker: claim.marker,
    });
    return;
  }

  try {
    const tokenInfo = await queryTokenInfo(hookInput.session_id);
    const hookEvents = await readHookEvents(hookInput.session_id);
    const turn = parseTurn(events, hookInput, tokenInfo, hookEvents);
    const spans = buildSpans(config, hookInput, turn);
    const metrics = buildQoderMetrics(spans);
    await appendLog("prepared qoder spans", {
      session_id: hookInput.session_id,
      turn_id: turn.requestId,
      fingerprint,
      transcript_events: events.length,
      token_rows: tokenInfo.rows?.length ?? 0,
      hook_events: hookEvents.length,
      spans: spans.length,
      llm_spans: spans.filter((span) => span.name === "llm").length,
      tool_spans: spans.filter((span) => span.name.startsWith("tool:")).length,
      skill_spans: spans.filter((span) => span.name.startsWith("skill:")).length,
      metric_points: metrics.length,
      metric_names: [...new Set(metrics.map((metric) => metric.name))],
    });
    const traceResponse = await uploadTraces(config, spans);
    const metricsResponse = await uploadMetrics(config, metrics);
    const uploadDetails = {
      session_id: hookInput.session_id,
      fingerprint,
      spans: spans.length,
      metric_points: metrics.length,
      trace_id: spans[0]?.trace_id,
      span_names: spans.map((span) => span.name),
      operation_names: spans.map((span) => span.attributes?.["gen_ai.operation.name"]).filter(Boolean),
      llm_spans: spans.filter((span) => span.name === "llm").length,
      trace_response: traceResponse,
      metrics_response: metricsResponse,
    };
    await saveState(hookInput.session_id, { lastUploadedFingerprint: fingerprint, uploadedAt: new Date().toISOString() });
    await completeUploadMarker(claim.marker, uploadDetails);
    await appendLog("uploaded qoder spans", uploadDetails);
  } catch (error) {
    await releaseUploadClaim(claim.marker);
    throw error;
  }
}

process.on("unhandledRejection", (error) => {
  void appendLog("unhandledRejection", { error: error?.message ?? String(error), stack: error?.stack });
});

runHook().catch(async (error) => {
  await appendLog("failed", { error: error?.message ?? String(error), stack: error?.stack });
});
