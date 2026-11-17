/**
 * ChatGPT OAuth credential store, backed by Obsidian's SecretStorage.
 *
 * Why SecretStorage:
 * - Credentials never land in `data.json` (which syncs across devices).
 * - The OS keychain is the right place for refreshable bearer tokens.
 * - Matches how upstream stores Anthropic / OpenAI API keys.
 *
 * Storage shape: a single JSON-serialized `ChatGPTOAuthCredential` under
 * `OAUTH_SECRET_KEY`. We keep one credential per device and read the
 * upstream keys as fallbacks so an existing sign-in can be reused.
 */
import type { App } from "obsidian";
import { LEGACY_PLUGIN_ID, PLUGIN_ID } from "../constants";

export interface ChatGPTOAuthCredential {
  accessToken: string;
  refreshToken: string;
  /** Epoch ms when the access token expires. */
  expiresAt: number;
  /** Epoch ms when this record was last written. */
  updatedAt: number;
  /** Optional ChatGPT account id, used as a request header. */
  accountId?: string;
  /** Optional id_token, kept for diagnostics. */
  idToken?: string;
}

// Obsidian's SecretStorage validates IDs as "lowercase alphanumeric with
// optional dashes" — no colons or uppercase. Keep this in sync with the
// plugin id so the OS keychain entries are easy to identify.
const OAUTH_SECRET_KEY = `${PLUGIN_ID}-chatgpt-oauth`;
const LEGACY_OAUTH_SECRET_KEYS = [
  `${LEGACY_PLUGIN_ID}-chatgpt-oauth`,
  "obsidian-chatting-chatgpt-oauth",
] as const;
const EXPIRY_BUFFER_MS = 30_000;

export class ChatGPTOAuthStore {
  constructor(private readonly app: App) {}

  /** Read the stored credential. Returns null if absent or malformed. */
  get(): ChatGPTOAuthCredential | null {
    let raw: string | null = null;
    try {
      raw = this.app.secretStorage.getSecret(OAUTH_SECRET_KEY) ?? null;
      for (const key of LEGACY_OAUTH_SECRET_KEYS) {
        if (raw) break;
        raw = this.app.secretStorage.getSecret(key) ?? null;
      }
    } catch {
      return null;
    }
    if (!raw) return null;

    let parsed: Partial<ChatGPTOAuthCredential>;
    try {
      parsed = JSON.parse(raw) as Partial<ChatGPTOAuthCredential>;
    } catch {
      return null;
    }

    if (
      typeof parsed.accessToken !== "string" ||
      typeof parsed.refreshToken !== "string" ||
      typeof parsed.expiresAt !== "number" ||
      typeof parsed.updatedAt !== "number"
    ) {
      return null;
    }

    return {
      accessToken: parsed.accessToken,
      refreshToken: parsed.refreshToken,
      expiresAt: parsed.expiresAt,
      updatedAt: parsed.updatedAt,
      ...(typeof parsed.accountId === "string" ? { accountId: parsed.accountId } : {}),
      ...(typeof parsed.idToken === "string" ? { idToken: parsed.idToken } : {}),
    };
  }

  /** Write the credential. */
  set(credential: ChatGPTOAuthCredential): void {
    try {
      this.app.secretStorage.setSecret(OAUTH_SECRET_KEY, JSON.stringify(credential));
    } catch {
      // SecretStorage unavailable (very old Obsidian). Fail silently — the
      // user will see a "not connected" state on the next read.
    }
  }

  /** Erase the credential. SecretStorage has no delete API, so we overwrite with empty. */
  clear(): void {
    try {
      this.app.secretStorage.setSecret(OAUTH_SECRET_KEY, "");
    } catch {
      // ignore
    }
  }

  /** True if the access token has already expired (or expires within ~30s). */
  isExpired(credential: Pick<ChatGPTOAuthCredential, "expiresAt">): boolean {
    return credential.expiresAt <= Date.now() + EXPIRY_BUFFER_MS;
  }
}
