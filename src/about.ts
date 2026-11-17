import { requestUrl } from "obsidian";

export const STARK_REPOSITORY_URL = "https://github.com/SuShuheng/obsidian-stark";
export const STARK_RELEASES_API = "https://api.github.com/repos/SuShuheng/obsidian-stark/releases/latest";

export interface LatestRelease {
  version: string;
  url: string;
  publishedAt?: string;
}

const RELEASE_CHECK_TIMEOUT_MS = 15_000;

export type UpdateResult =
  | { status: "update"; release: LatestRelease }
  | { status: "current"; release: LatestRelease }
  | { status: "no-release" }
  | { status: "error"; message: string };

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`GitHub request timed out after ${Math.round(timeoutMs / 1000)} seconds.`)), timeoutMs);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); },
    );
  });
}

/** Numeric SemVer comparison; pre-release suffixes compare after the release. */
export function compareVersions(left: string, right: string): number {
  const parse = (value: string) => {
    const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(value.trim());
    if (!match) return null;
    return {
      parts: [Number(match[1]), Number(match[2]), Number(match[3])],
      pre: match[4] ?? "",
    };
  };
  const a = parse(left);
  const b = parse(right);
  if (!a || !b) return left.localeCompare(right, undefined, { numeric: true });
  for (let i = 0; i < 3; i++) {
    if (a.parts[i] !== b.parts[i]) return a.parts[i] - b.parts[i];
  }
  if (!a.pre && !b.pre) return 0;
  if (!a.pre) return 1;
  if (!b.pre) return -1;
  return a.pre.localeCompare(b.pre, undefined, { numeric: true });
}

/** Read the latest stable GitHub Release; never downloads or installs it. */
export async function checkLatestRelease(currentVersion: string): Promise<UpdateResult> {
  let response;
  try {
    response = await withTimeout(requestUrl({
      url: STARK_RELEASES_API,
      method: "GET",
      headers: {
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      throw: false,
    }), RELEASE_CHECK_TIMEOUT_MS);
  } catch (error) {
    return { status: "error", message: error instanceof Error ? error.message : String(error) };
  }
  if (response.status === 404) return { status: "no-release" };
  if (response.status < 200 || response.status >= 300) {
    const remaining = response.headers?.["x-ratelimit-remaining"];
    const suffix = response.status === 403 && remaining === "0"
      ? " (GitHub API rate limit reached; try again later)"
      : "";
    return { status: "error", message: `GitHub returned HTTP ${response.status}${suffix}.` };
  }
  const data: unknown = response.json;
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return { status: "error", message: "GitHub returned an invalid release response." };
  }
  const release = data as Record<string, unknown>;
  const tag = typeof release.tag_name === "string" ? release.tag_name.trim() : "";
  const version = tag.replace(/^v/i, "");
  const url = typeof release.html_url === "string" ? release.html_url : "";
  if (!version || release.draft === true || release.prerelease === true) return { status: "no-release" };
  if (!/^https:\/\/github\.com\/SuShuheng\/obsidian-stark\/releases\//i.test(url)) {
    return { status: "error", message: "GitHub returned an unexpected release URL." };
  }
  const latest: LatestRelease = {
    version,
    url,
    ...(typeof release.published_at === "string" ? { publishedAt: release.published_at } : {}),
  };
  return compareVersions(version, currentVersion) > 0
    ? { status: "update", release: latest }
    : { status: "current", release: latest };
}
