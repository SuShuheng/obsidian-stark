import { oauthReasoning, oauthParallelTools, getCodexClientVersion, cachedCatalog, catalogIdentity } from "./model-catalog";
import { Platform } from "obsidian";
import { RequestBudgetError } from "./request-budget";
import { compactThreshold } from "../agent/compaction";
import { effectiveModelOption } from "../model-preferences";
/**
 * ChatGPT OAuth API client.
 *
 * Talks to the ChatGPT/Codex Responses-style endpoint using a bearer token
 * obtained via the Device Authorization Flow (see ../auth/chatgptOAuth.ts).
 *
 * Transport: always `stream: true`. The Codex backend rejects `stream:false`
 * outright with 400 `"Stream must be set to true"`, and the official Codex
 * CLI / other working OAuth-Codex clients never send anything else either.
 * The answer streams through `api/stream.ts` like the other providers' (on
 * desktop through Node's `https`); where that can't reach the backend
 * (mobile `fetch` blocked by CORS), `requestUrl()` buffers the whole SSE
 * body and its events are parsed at once, as before.
 *
 * Conversation continuity is **client-side**: we always send `store: false`
 * (the Codex backend rejects requests without it) and replay the full
 * conversation history into `input` every turn. We deliberately do NOT use
 * `previous_response_id` — it requires the server to persist the previous
 * response, which is incompatible with `store: false`.
 */
import type {
  ChatSettings,
  UnifiedMessage,
  UnifiedToolDef,
  UnifiedResponse,
  StreamOptions,
} from "../types";
import { buildResponsesInput, compactionParameter, fromResponsesOutput, sendResponsesRequest } from "./responses-format";
import type { StreamResult } from "./stream";
import { ProviderError, StreamCutError } from "./errors";
import { asRecord, getNestedString, isRecord } from "../json";
import {
  ChatGPTOAuthError,
  type ChatGPTOAuthService,
} from "../auth/chatgptOAuth";

const CODEX_RESPONSES_URL = "https://chatgpt.com/backend-api/codex/responses";

/**
 * `originator` header value.
 *
 * The Codex backend uses this header to identify which client is calling
 * `/codex/responses`. Codex itself sends `"codex_cli_rs"`; using the same
 * identity also enables the reasoning-summary event stream in the app.
 */
const ORIGINATOR = "codex_cli_rs";

// Settings uses the account-specific Codex catalog, preserving custom model IDs.

/** The Codex route refused server-side compaction once (until Obsidian restarts). */
let compactionRefused = false;
/** The Codex route refused summary stream options once (until Obsidian restarts). */
let summaryStreamRefused = false;

/** Whether the Codex route compacts on its side (else the plugin summarizes). */
export function chatgptCompacts(): boolean {
  return !compactionRefused;
}

/** Held by main.ts; injected via setChatGPTOAuthService(). */
let oauthService: ChatGPTOAuthService | null = null;

export function setChatGPTOAuthService(service: ChatGPTOAuthService | null): void {
  oauthService = service;
}

/**
 * Reset any per-conversation client state (called from AgentLoop.clear()).
 *
 * The Codex backend forces us into stateless mode, so we don't actually
 * keep any cross-turn server identifiers. This function exists so the
 * agent loop can call it uniformly alongside the OpenAI provider's reset
 * — and so we have one place to add new state if we ever introduce it.
 */
export function clearChatGPTOAuthState(): void {
  /* no-op: history lives entirely in AgentLoop.messages */
}

/** Account identity for deciding whether encrypted compaction can be replayed. */
export async function chatgptReplayIdentity(): Promise<string | undefined> {
  const credential = await oauthService?.getUsableCredential();
  return credential ? catalogIdentity("chatgpt-oauth", credential.accountId || credential.accessToken) : undefined;
}

export async function sendChatGPTOAuthMessage(
  settings: ChatSettings,
  messages: UnifiedMessage[],
  tools: UnifiedToolDef[],
  systemPrompt: string,
  shouldStop: () => boolean = () => false,
  stream: StreamOptions = {},
): Promise<UnifiedResponse> {
  if (!oauthService) {
    throw new ChatGPTOAuthError(
      "ChatGPT OAuth service is not initialized. Reload the plugin.",
    );
  }

  const service = oauthService;
  let credential;
  try {
    credential = await service.getUsableCredential();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new ChatGPTOAuthError(
      `ChatGPT OAuth session expired and refresh failed. Please reconnect your ChatGPT account in settings. (${msg})`,
    );
  }
  if (!credential) {
    throw new ChatGPTOAuthError(
      "ChatGPT OAuth is not connected. Open Settings -> Stark -> Connect ChatGPT.",
    );
  }

  const identity = await catalogIdentity("chatgpt-oauth", credential.accountId || credential.accessToken);
  if (stream.expectedAccountIdentity !== undefined && stream.expectedAccountIdentity !== identity) {
    throw new ChatGPTOAuthError("The ChatGPT account changed before the request was sent.");
  }
  if (settings.modelCatalog) {
    cachedCatalog(settings.modelCatalog, "chatgpt-oauth", identity);
  }
  const model = settings.model;

  const baseBody: Record<string, unknown> = {
    model,
    // Replay the full conversation each turn — Codex's `store:false` mode
    // makes server-side `previous_response_id` chaining unavailable.
    input: buildResponsesInput(messages, "chatgpt-oauth", model, identity),
    instructions: systemPrompt,
    // Required by the Codex backend; omitting it returns
    // 400 {"detail":"Store must be set to false"}.
    store: false,
    // The conversation names the prompt cache, as Codex sends it.
    ...(stream.conversationId ? { prompt_cache_key: stream.conversationId } : {}),
    // Match the request shape used by other working Codex-via-OAuth clients
    // (verified against the OpenAI Codex CLI and external references). These
    // fields aren't strictly documented as required, but Codex's response
    // pipeline expects them and at least one is required for reasoning models.
    parallel_tool_calls: oauthParallelTools(model),
    // Server-side compaction at the catalog's point (`auto_compact_token_limit`
    // or 80 % of the window), as for OpenAI; not after this route refused it.
    ...(compactionRefused ? {} : compactionParameter(compactThreshold("chatgpt-oauth", effectiveModelOption(settings, "chatgpt-oauth", model), settings))),
  };

  const reasoning = oauthReasoning(model, settings.thinkingLevel);
  if (reasoning) {
    baseBody.reasoning = reasoning;
    // Codex requires the encrypted reasoning payload to be threaded through
    // the request when reasoning is enabled. Without this, the backend
    // sometimes returns 400 on follow-up turns.
    baseBody.include = ["reasoning.encrypted_content"];
    if (reasoning.summary && !summaryStreamRefused) {
      baseBody.stream_options = { reasoning_summary_delivery: "sequential_cutoff" };
    }
  }

  const apiTools: Record<string, unknown>[] = tools.map((t) => ({
    type: "function",
    name: t.name,
    description: t.description,
    parameters: t.inputSchema,
    // Codex backend (and the OpenAI Responses API generally) accepts
    // `strict` on function tools. Setting `false` matches what the
    // official Codex CLI / other working OAuth-Codex clients send and
    // avoids unintended structured-output validation on free-form tools.
    strict: false,
  }));
  if (settings.enableWebSearch) {
    // Codex backend uses the canonical name `web_search` (per
    // openai/codex `codex-rs/tools/src/tool_spec.rs`'s
    // `#[serde(rename = "web_search")]`). The older
    // `web_search_preview` name from the public Responses-API preview
    // is rejected with HTTP 400 `"Unsupported tool type: web_search_preview"`.
    apiTools.push({ type: "web_search" });
  }
  if (apiTools.length > 0) {
    baseBody.tools = apiTools;
  }

  // Codex backend only accepts streaming requests.
  const body = { ...baseBody, stream: true };
  const checkCancelled = () => {
    if (shouldStop()) throw new Error("Request cancelled.");
  };
  checkCancelled();
  // The Codex route doesn't document `context_management`. A 400 to a
  // request with it sends the request again without; if that one goes
  // through, the route refused it, and from then on the plugin summarizes
  // the chat itself instead.
  const attempt = async (accessToken: string, accountId: string | undefined): Promise<UnifiedResponse> => {
    try {
      return await sendOnce(body, accessToken, accountId, identity, stream);
    } catch (e) {
      if (!(e instanceof ProviderError) || e.status !== 400) throw e;
      checkCancelled();
      const reduced = { ...body };
      let changed = false;
      if ("context_management" in reduced) {
        delete reduced.context_management;
        compactionRefused = true;
        changed = true;
      }
      if ("stream_options" in reduced) {
        delete reduced.stream_options;
        summaryStreamRefused = true;
        changed = true;
      }
      if (!changed) throw e;
      return sendOnce(reduced, accessToken, accountId, identity, stream);
    }
  };
  try {
    return await attempt(credential.accessToken, credential.accountId);
  } catch (e) {
    // A rejected token (401), e.g. revoked before it expired: refresh once
    // and retry once. A second 401, or a failed refresh, keeps the
    // "reconnect" error.
    if (!(e instanceof ProviderError) || e.status !== 401) throw e;
    checkCancelled();
    let renewed;
    try {
      renewed = await service.renewRejected(credential);
    } catch {
      throw e;
    }
    checkCancelled();
    if (!renewed) throw e;
    return attempt(renewed.accessToken, renewed.accountId);
  }
}

async function sendOnce(
  body: Record<string, unknown>,
  accessToken: string,
  accountId: string | undefined,
  identity: string,
  stream: StreamOptions,
): Promise<UnifiedResponse> {
  const version = getCodexClientVersion();
  const platform = Platform.isWin ? "windows" : Platform.isMacOS ? "macos" : "linux";
  const headers: Record<string, string> = {
    Authorization: `Bearer ${accessToken}`,
    "Content-Type": "application/json",
    Accept: "text/event-stream, application/json",
    "User-Agent": `codex_cli_rs/${version} (${platform}; unknown) obsidian`,
    version,
    originator: ORIGINATOR,
  };
  if (accountId) {
    headers["ChatGPT-Account-Id"] = accountId;
  }
  // With the conversation as session (as Codex sends it) the backend caches
  // the conversation, not only the tool definitions.
  if (stream.conversationId) headers.session_id = stream.conversationId;

  let data: Record<string, unknown>;
  try {
    data = await sendResponsesRequest(CODEX_RESPONSES_URL, headers, body, stream, "ChatGPT", {
      http: httpError,
      // Status 0: the error came inside a response that had started.
      stream: ({ message, code }) => new ProviderError(message, 0, code),
    });
  } catch (e: unknown) {
    // Answers from the backend, a cut stream, Stop and a request over the
    // size limit (rolled back by the loop) keep their errors; a request
    // that never got an answer says so.
    if (e instanceof ProviderError || e instanceof StreamCutError || e instanceof RequestBudgetError || stream.signal?.aborted) throw e;
    const err = asRecord(e);
    const status = typeof err.status === "number" || typeof err.status === "string" ? String(err.status) : "";
    const message = typeof err.message === "string" ? err.message : String(e);
    throw new ChatGPTOAuthError(
      `ChatGPT OAuth request failed (${status}): ${message}`,
    );
  }
  return fromResponsesOutput(data, "chatgpt-oauth", typeof body.model === "string" ? body.model : undefined, identity);
}

function httpError(response: StreamResult): Error {
  if (response.status === 401 || response.status === 403) {
    // The status lets the caller refresh the token once after a 401.
    return new ProviderError(
      `ChatGPT OAuth session rejected by the server (HTTP ${response.status}). Please reconnect your ChatGPT account in settings.`,
      response.status,
    );
  }
  // Codex returns errors as either `{detail: "..."}` (FastAPI-style) or
  // `{error: {message: "..."}}` (OpenAI-style). Extract whichever is
  // present; fall back to the raw body so the cause is never lost.
  const json = isRecord(response.json) ? response.json : undefined;
  const detail = json?.detail;
  const detailText =
    typeof detail === "string"
      ? detail
      : getNestedString(detail, ["message"]);
  const apiMsg =
    detailText ??
    getNestedString(json, ["error", "message"]) ??
    response.text?.slice(0, 300) ??
    `HTTP ${response.status}`;
  // The Codex backend names a plan's usage limit in `error.type` (also a 429).
  const code = getNestedString(json, ["error", "code"]) ?? getNestedString(json, ["error", "type"]);
  return new ProviderError(
    `ChatGPT OAuth request failed (${response.status}): ${apiMsg}. The Codex backend may not accept the selected model or request format. Try reconnecting, picking a different model, or switching to OpenAI API Key.`,
    response.status, code, response.retryAfterMs,
  );
}
