import { Platform } from "obsidian";
import type { NetworkProxyConfig } from "../types";

type ExecFile = (file: string, args: string[], options: Record<string, unknown>, callback: (error: Error | null, stdout: string) => void) => void;

export interface ProxyProbe {
  source: "environment" | "windows" | "mac" | "none" | "direct" | "manual" | "bypass" | "mobile";
  url?: string;
  detail?: string;
}

const CACHE_MS = 5 * 60_000;
let cached: { key: string; probe: ProxyProbe; at: number } | undefined;
let lastProbe: ProxyProbe | undefined;

/** The latest resolution without credentials, for safe diagnostics. */
export function lastProxyProbe(): ProxyProbe | undefined {
  return lastProbe ? { ...lastProbe } : undefined;
}

function runtimeRequire<T>(id: string): T | undefined {
  if (!Platform.isDesktopApp || typeof window === "undefined") return undefined;
  const load = (window as unknown as { require?: (name: string) => unknown }).require;
  if (typeof load === "function") {
    try {
      return load(id) as T | undefined;
    } catch {
      // Some Electron builds expose Node only through the bundle's require.
    }
  }
  try {
    return require(id) as T | undefined;
  } catch {
    return undefined;
  }
}

function windowsHost(): boolean {
  const platform = (globalThis as unknown as { process?: { platform?: string } }).process?.platform;
  return Platform.isWin || platform === "win32";
}

function macHost(): boolean {
  const platform = (globalThis as unknown as { process?: { platform?: string } }).process?.platform;
  return Platform.isMacOS || platform === "darwin";
}

function run(file: string, args: string[]): Promise<{ stdout: string; error?: string }> {
  const child = runtimeRequire<{ execFile?: ExecFile }>("child_process");
  if (!child?.execFile) return Promise.resolve({ stdout: "", error: "child_process unavailable" });
  return new Promise((resolve) => {
    child.execFile!(file, args, { windowsHide: true, timeout: 2500, maxBuffer: 64 * 1024 },
      (error, stdout) => resolve(error ? { stdout: "", error: error.message } : { stdout: String(stdout ?? "") }));
  });
}

/** Normalize a system proxy value such as `http=host:port;https=host:port`. */
export function normalizeProxyUrl(value: string | undefined): string | undefined {
  let raw = value?.trim() ?? "";
  if (!raw) return undefined;
  if (/^[a-z][a-z0-9+.-]*=/i.test(raw) || raw.includes("=")) {
    const parts = new Map(raw.split(";").map((part) => {
      const at = part.indexOf("=");
      return at === -1 ? ["", part.trim()] : [part.slice(0, at).trim().toLowerCase(), part.slice(at + 1).trim()];
    }));
    raw = parts.get("https") || parts.get("http") || "";
  }
  if (!raw) return undefined;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) raw = `http://${raw}`;
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== "http:") return undefined;
    if (!parsed.hostname || !parsed.port) return undefined;
    // Manual proxy credentials would otherwise be persisted in data.json.
    // Use the OS/system proxy for authenticated proxies instead.
    if (parsed.username || parsed.password) return undefined;
    return parsed.toString();
  } catch {
    return undefined;
  }
}

function envProxy(): string | undefined {
  const env = (globalThis as unknown as { process?: { env?: Record<string, string | undefined> } }).process?.env ?? {};
  return normalizeProxyUrl(env.HTTPS_PROXY || env.https_proxy || env.ALL_PROXY || env.all_proxy ||
    env.HTTP_PROXY || env.http_proxy);
}

function bypassed(target: string): boolean {
  const env = (globalThis as unknown as { process?: { env?: Record<string, string | undefined> } }).process?.env ?? {};
  const raw = env.NO_PROXY || env.no_proxy || "";
  if (!raw) return false;
  const host = new URL(target).hostname.toLowerCase();
  return raw.split(",").map((item) => item.trim().toLowerCase()).filter(Boolean).some((item) => {
    if (item === "*") return true;
    const value = item.replace(/^\./, "");
    return host === value || host.endsWith(`.${value}`);
  });
}

async function windowsProxy(): Promise<ProxyProbe> {
  if (!windowsHost()) return { source: "none", detail: "not Windows" };
  const key = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings";
  const [enabled, server] = await Promise.all([
    run("reg.exe", ["query", key, "/v", "ProxyEnable"]),
    run("reg.exe", ["query", key, "/v", "ProxyServer"]),
  ]);
  if (enabled.error || server.error) {
    return { source: "windows", detail: enabled.error ?? server.error };
  }
  if (!/ProxyEnable\s+REG_DWORD\s+0x1\b/i.test(enabled.stdout)) {
    return { source: "windows", detail: "ProxyEnable is off or unreadable" };
  }
  const url = normalizeProxyUrl(/ProxyServer\s+REG_SZ\s+(.+)/i.exec(server.stdout)?.[1]?.trim());
  return url ? { source: "windows", url } : { source: "windows", detail: "ProxyServer is unsupported" };
}

async function macProxy(): Promise<ProxyProbe> {
  if (!macHost()) return { source: "none", detail: "not macOS" };
  const result = await run("scutil", ["--proxy"]);
  if (result.error) return { source: "mac", detail: result.error };
  const output = result.stdout;
  const lines = new Map(output.split(/\r?\n/).map((line) => {
    const at = line.indexOf(":");
    return at < 0 ? ["", ""] : [line.slice(0, at).trim(), line.slice(at + 1).trim()];
  }));
  const host = lines.get("HTTPSProxy") || lines.get("HTTPProxy");
  const port = lines.get("HTTPSPort") || lines.get("HTTPPort");
  const enabled = lines.get("HTTPSEnable") === "1" || lines.get("HTTPEnable") === "1";
  const url = enabled && host && port ? normalizeProxyUrl(`${host}:${port}`) : undefined;
  return url ? { source: "mac", url } : { source: "mac", detail: "HTTP proxy is off or incomplete" };
}

async function systemProxy(): Promise<ProxyProbe> {
  const fromEnvironment = envProxy();
  if (fromEnvironment) return { source: "environment", url: fromEnvironment };
  if (windowsHost()) return windowsProxy();
  if (macHost()) return macProxy();
  return { source: "none", detail: "no supported system proxy source" };
}

/** The HTTP proxy the desktop streaming transport should use, if any. */
export async function proxyForUrl(target: string, config: NetworkProxyConfig | undefined): Promise<string | undefined> {
  const mode = config?.mode ?? "system";
  if (mode === "direct") {
    lastProbe = { source: "direct" };
    return undefined;
  }
  if (!Platform.isDesktopApp) {
    lastProbe = { source: "mobile" };
    return undefined;
  }
  if (mode === "manual") {
    const url = normalizeProxyUrl(config?.url);
    lastProbe = url ? { source: "manual", url } : { source: "manual", detail: "invalid manual proxy" };
    return url;
  }
  if (bypassed(target)) {
    lastProbe = { source: "bypass" };
    return undefined;
  }
  const key = target;
  if (cached && cached.key === key && Date.now() - cached.at < CACHE_MS) {
    lastProbe = { ...cached.probe };
    return cached.probe.url;
  }
  const probe = await systemProxy();
  lastProbe = { ...probe };
  cached = { key, probe: { ...probe }, at: Date.now() };
  return probe.url;
}

/** For tests and after a network change. */
export function resetProxyCache(): void {
  cached = undefined;
}

export function proxyAuthorization(proxyUrl: string): string | undefined {
  try {
    const url = new URL(proxyUrl);
    if (!url.username && !url.password) return undefined;
    const credentials = `${decodeURIComponent(url.username)}:${decodeURIComponent(url.password)}`;
    return `Basic ${btoa(credentials)}`;
  } catch {
    return undefined;
  }
}
