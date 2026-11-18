import {
  App,
  TFile,
  TFolder,
  getFrontMatterInfo,
  normalizePath,
  Platform,
  prepareFuzzySearch,
  type DataAdapter,
  type ListedFiles,
} from "obsidian";
import type { ToolResult, MentionContext, SkillPreference } from "../types";

/**
 * Skills, as Claude Code and Codex have them: a folder per skill in the
 * vault's skills folder, with a `SKILL.md` whose properties give its
 * `name` and `description`, and any other files it needs. The system
 * prompt lists names and descriptions; `use_skill` loads a skill's
 * instructions when the model picks it; `/name` in a message loads it
 * along with the message.
 */

export const SKILL_FILE = "SKILL.md";
export const DEFAULT_SKILLS_FOLDER = ".agents/skills";
/** A visible copy for mobile, whose adapters and Obsidian Sync may not expose dot folders. */
export const MOBILE_SKILLS_FOLDER = "Stark Skills";
/** Characters of a SKILL.md given to the model (as for AGENTS.md). */
export const SKILL_CHARS = 32768;
/** A skill's other files listed at most. */
const MAX_RESOURCES = 50;
/** Offered in the `/` list. */
const CANDIDATES = 8;

export interface Skill {
  name: string;
  description: string;
  /** The SKILL.md file. */
  path: string;
}

type SkillPreferences = Record<string, SkillPreference> | undefined;

/** Hidden `.agents` folders aren't indexed by Obsidian's Vault API; keep their scan here. */
const hiddenSkills = new WeakMap<object, Map<string, Skill[]>>();

function hiddenSkillsFor(app: App): Map<string, Skill[]> {
  let skills = hiddenSkills.get(app.vault);
  if (!skills) {
    skills = new Map();
    hiddenSkills.set(app.vault, skills);
  }
  return skills;
}

function skillsFolder(folder: string): string {
  return normalizePath(folder || DEFAULT_SKILLS_FOLDER);
}

function skillFolder(path: string): string {
  const at = path.lastIndexOf("/");
  return at < 0 ? "" : path.slice(0, at);
}

function frontMatterValues(text: string): Record<string, string> {
  const info = getFrontMatterInfo(text);
  if (!info.exists) return {};
  const values: Record<string, string> = {};
  for (const line of info.frontmatter.split(/\r?\n/)) {
    const match = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line);
    if (!match) continue;
    let value = match[2].trim();
    if (value.startsWith('"') && value.endsWith('"')) {
      try {
        value = JSON.parse(value) as string;
      } catch {
        value = value.slice(1, -1);
      }
    } else if (value.startsWith("'") && value.endsWith("'")) {
      value = value.slice(1, -1).replace(/''/g, "'");
    }
    values[match[1]] = value;
  }
  return values;
}

function visibleSkills(app: App, key: string): Skill[] {
  const root = app.vault.getFolderByPath(key);
  if (!(root instanceof TFolder)) return [];
  const skills: Skill[] = [];
  for (const child of root.children) {
    if (!(child instanceof TFolder)) continue;
    const file = app.vault.getFileByPath(`${child.path}/${SKILL_FILE}`);
    if (!file) continue;
    const properties: unknown = app.metadataCache.getFileCache(file)?.frontmatter;
    const value = (key: string) => {
      const found = properties && typeof properties === "object" ? (properties as Record<string, unknown>)[key] : undefined;
      return typeof found === "string" ? found.trim() : "";
    };
    // The folder's name when the file has none, as Claude Code does.
    skills.push({ name: value("name") || child.name, description: value("description"), path: file.path });
  }
  return skills.sort((a, b) => a.name.localeCompare(b.name));
}

function rememberSkills(app: App, key: string, skills: Skill[]): Skill[] {
  const sorted = [...skills].sort((a, b) => a.name.localeCompare(b.name));
  hiddenSkillsFor(app).set(key, sorted);
  return sorted;
}

function cleanAdapterPath(path: string): string {
  return path.replace(/[\\/]+$/, "");
}

async function listAdapterFolder(adapter: DataAdapter, path: string): Promise<ListedFiles> {
  const clean = cleanAdapterPath(normalizePath(path));
  const candidates = [...new Set([clean, `/${clean}`].filter(Boolean))];
  let empty: ListedFiles = { files: [], folders: [] };
  for (const candidate of candidates) {
    try {
      const listing = await adapter.list(candidate);
      if (listing.files.length || listing.folders.length) return listing;
      empty = listing;
    } catch {
      // Some mobile adapters reject a style of path; try the next one.
    }
  }
  return empty;
}

function normalizedListedPath(root: string, path: string): string {
  const clean = cleanAdapterPath(normalizePath(path));
  if (clean === root || clean.startsWith(`${root}/`)) return clean;
  return normalizePath(`${root}/${clean}`);
}

/**
 * Hidden `.agents/skills` is absent from Obsidian's Vault index. On mobile it
 * can also be absent from Obsidian Sync, so a visible `Stark Skills` copy is
 * used as a fallback when it exists.
 */
async function adapterSkills(app: App, key: string): Promise<Skill[]> {
  const adapter = app.vault.adapter;
  if (!adapter?.list) return [];
  const listing = await listAdapterFolder(adapter, key);
  const directories = new Set<string>();
  for (const folder of listing.folders) directories.add(normalizedListedPath(key, folder));
  for (const file of listing.files) {
    const clean = cleanAdapterPath(normalizePath(file));
    if (clean.split("/").pop()?.toLocaleLowerCase() !== SKILL_FILE.toLocaleLowerCase()) continue;
    directories.add(skillFolder(clean));
  }
  const normalizedSkills: Skill[] = [];
  for (const directory of directories) {
    try {
      const details = await listAdapterFolder(adapter, directory);
      const listed = details.files.find((file) =>
        file.split("/").pop()?.toLocaleLowerCase() === SKILL_FILE.toLocaleLowerCase());
      if (!listed) continue;
      const skillFile = normalizedListedPath(directory, listed);
      const text = await adapter.read(skillFile);
      const properties = frontMatterValues(text);
      normalizedSkills.push({
        name: properties.name?.trim() || directory.split("/").pop() || directory,
        description: properties.description?.trim() || "",
        path: normalizePath(skillFile),
      });
    } catch {
      // A removed or unreadable directory doesn't hide the others.
    }
  }
  return normalizedSkills;
}

/** Every skill in `folder`: the scan cache, the Vault index, then the mobile mirror. */
export function allSkills(app: App, folder: string): Skill[] {
  const key = skillsFolder(folder);
  const cached = hiddenSkillsFor(app).get(key);
  if (cached) return cached;
  const visible = visibleSkills(app, key);
  if (visible.length || app.vault.getFolderByPath(key) instanceof TFolder) {
    return rememberSkills(app, key, visible);
  }
  if (key !== MOBILE_SKILLS_FOLDER) {
    const mirrored = visibleSkills(app, MOBILE_SKILLS_FOLDER);
    if (mirrored.length) return rememberSkills(app, key, mirrored);
  }
  return [];
}

/** Scan the live Vault index, hidden adapters, and the mobile-visible mirror. */
export async function refreshSkills(app: App, folder: string): Promise<Skill[]> {
  const key = skillsFolder(folder);
  const candidates = key === MOBILE_SKILLS_FOLDER ? [key] : [key, MOBILE_SKILLS_FOLDER];
  for (const candidate of candidates) {
    const visible = visibleSkills(app, candidate);
    if (visible.length) {
      const found = rememberSkills(app, key, visible);
      if (Platform.isDesktopApp && key !== MOBILE_SKILLS_FOLDER) {
        await copySkillsToMobile(app, found).catch(() => undefined);
      }
      return found;
    }
    const hidden = await adapterSkills(app, candidate);
    if (hidden.length) {
      const found = rememberSkills(app, key, hidden);
      if (Platform.isDesktopApp && key !== MOBILE_SKILLS_FOLDER) {
        await copySkillsToMobile(app, found).catch(() => undefined);
      }
      return found;
    }
  }
  return rememberSkills(app, key, []);
}

/** A skill is enabled unless its SKILL.md path was explicitly disabled. */
export function skillEnabled(preferences: SkillPreferences, skill: Skill): boolean {
  return preferences?.[skill.path]?.enabled !== false;
}

/** The enabled skills in `folder`. */
export function findSkills(app: App, folder: string, preferences?: SkillPreferences): Skill[] {
  return allSkills(app, folder).filter((skill) => skillEnabled(preferences, skill));
}

/** For the system prompt: the skills and when to use them; null without skills. */
export function skillsPrompt(skills: Skill[]): string | null {
  if (skills.length === 0) return null;
  const list = skills.map((skill) => `- ${skill.name}: ${skill.description || "(no description)"}`).join("\n");
  return `Skills are instructions for particular tasks that the user keeps in the vault. When a task matches a skill's description, call use_skill with its name before you start, then follow it. A message that names a skill as /name has it loaded already.

${list}`;
}

/** The skill named `name` (any case). */
export function skillNamed(skills: Skill[], name: string): Skill | undefined {
  const wanted = name.trim().replace(/^\//, "").toLowerCase();
  return skills.find((skill) => skill.name.toLowerCase() === wanted);
}

/**
 * A skill for the model: its instructions (SKILL.md without its
 * properties, capped) and the other files in its folder, which it reads
 * with the vault tools.
 */
export async function loadSkill(app: App, skill: Skill): Promise<string> {
  return (await loadSkillContext(app, skill)).text;
}

async function loadSkillContext(app: App, skill: Skill): Promise<{ text: string; paths: string[] }> {
  const file = app.vault.getFileByPath(skill.path);
  let text: string;
  let resources: string[];
  if (file) {
    text = await app.vault.cachedRead(file);
    resources = file.parent ? filesIn(file.parent).filter((path) => path !== file.path) : [];
  } else {
    const adapter = app.vault.adapter;
    try {
      text = await adapter.read(skill.path);
      resources = (await filesInAdapter(app, skillFolder(skill.path))).filter((path) => path !== skill.path);
    } catch {
      return { text: `The skill "${skill.name}" is gone (${skill.path} not found).`, paths: [skill.path] };
    }
  }
  const end = file ? app.metadataCache.getFileCache(file)?.frontmatterPosition?.end.offset : undefined;
  let body = (end !== undefined ? text.slice(end) : text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "")).trim();
  if (body.length > SKILL_CHARS) body = `${body.slice(0, SKILL_CHARS)}\n(cut after ${SKILL_CHARS} characters)`;
  const listed = resources.slice(0, MAX_RESOURCES).map((path) => `- ${path}`).join("\n");
  const more = resources.length > MAX_RESOURCES ? `\n…and ${resources.length - MAX_RESOURCES} more.` : "";
  return { paths: [skill.path, ...resources.slice(0, MAX_RESOURCES)], text: `<skill name="${skill.name}" path="${skill.path}">
${body || "(empty)"}
</skill>${resources.length ? `\nThe skill's other files (read them when its instructions call for them):\n${listed}${more}` : ""}` };
}

function filesIn(folder: TFolder): string[] {
  return folder.children.flatMap((child) =>
    child instanceof TFolder ? filesIn(child) : child instanceof TFile ? [child.path] : []).sort();
}

async function filesInAdapter(app: App, folder: string): Promise<string[]> {
  if (!folder) return [];
  const listing = await listAdapterFolder(app.vault.adapter, folder);
  const files = listing.files.map((file) => normalizedListedPath(folder, file));
  for (const child of listing.folders) {
    files.push(...await filesInAdapter(app, normalizedListedPath(folder, child)));
  }
  return files.sort();
}

async function ensureAdapterFolder(adapter: DataAdapter, path: string): Promise<void> {
  const clean = cleanAdapterPath(normalizePath(path));
  if (!clean || await adapter.exists(clean)) return;
  const parent = skillFolder(clean);
  if (parent) await ensureAdapterFolder(adapter, parent);
  await adapter.mkdir(clean);
}

function sameBytes(left: ArrayBuffer, right: ArrayBuffer): boolean {
  if (left.byteLength !== right.byteLength) return false;
  const a = new Uint8Array(left);
  const b = new Uint8Array(right);
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

async function copySkillsToMobile(app: App, skills: Skill[]): Promise<number> {
  const adapter = app.vault.adapter;
  let copied = 0;
  for (const skill of skills) {
    const from = skillFolder(skill.path);
    const name = from.split("/").pop() || skill.name;
    const to = normalizePath(`${MOBILE_SKILLS_FOLDER}/${name}`);
    if (from === to) continue;
    const sourceFolder = app.vault.getFolderByPath(from);
    const sourceFiles = sourceFolder instanceof TFolder
      ? filesIn(sourceFolder)
      : await filesInAdapter(app, from);
    for (const file of sourceFiles) {
      const relative = file.slice(from.length + 1);
      if (!relative) continue;
      const target = normalizePath(`${to}/${relative}`);
      await ensureAdapterFolder(adapter, skillFolder(target));
      const data = await adapter.readBinary(file);
      const existing = await adapter.exists(target)
        ? await adapter.readBinary(target).catch(() => undefined)
        : undefined;
      if (!existing || !sameBytes(existing, data)) await adapter.writeBinary(target, data);
    }
    copied++;
  }
  return copied;
}

/**
 * Copy the current skills to the visible mobile folder. Obsidian Sync doesn't
 * sync hidden dot folders, and some mobile adapters don't expose them.
 */
export async function mirrorSkillsForMobile(app: App, folder: string): Promise<number> {
  const source = skillsFolder(folder);
  if (source === MOBILE_SKILLS_FOLDER) return 0;
  await refreshSkills(app, source);
  return copySkillsToMobile(app, allSkills(app, source));
}

/** `use_skill`: the named skill's instructions and files; an error lists the skills there are. */
export async function useSkill(app: App, folder: string, input: Record<string, unknown>, preferences?: SkillPreferences): Promise<ToolResult> {
  await refreshSkills(app, folder);
  const skills = findSkills(app, folder, preferences);
  const name = typeof input.name === "string" ? input.name : "";
  const skill = skillNamed(skills, name);
  if (!skill) {
    return { result: `No skill named "${name}". Skills: ${skills.map((s) => s.name).join(", ") || "none"}.`, isError: true };
  }
  const loaded = await loadSkillContext(app, skill);
  return { result: loaded.text, isError: false, instructionPaths: loaded.paths };
}

/**
 * The skills a message names as `/name` (at its start or after a space;
 * any case), each once, in the order named. A name may have spaces (a
 * folder name) and may be followed by punctuation.
 */
export function invokedSkills(text: string, skills: Skill[]): Skill[] {
  return skills
    .map((skill) => {
      const name = skill.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      return { skill, at: text.search(new RegExp(`(?:^|\\s)\\/${name}(?![\\p{L}\\p{N}_-])`, "iu")) };
    })
    .filter((found) => found.at >= 0)
    .sort((a, b) => a.at - b.at)
    .map((found) => found.skill);
}

/** The skills a message invokes as `/name`, loaded, for its context; null when none. */
export async function invokedSkillsText(app: App, folder: string, text: string, preferences?: SkillPreferences): Promise<string | null> {
  return (await invokedSkillsContext(app, folder, text, preferences))?.text ?? null;
}

export async function invokedSkillsContext(app: App, folder: string, text: string, preferences?: SkillPreferences): Promise<MentionContext | null> {
  await refreshSkills(app, folder);
  const invoked = invokedSkills(text, findSkills(app, folder, preferences));
  if (invoked.length === 0) return null;
  const loaded = await Promise.all(invoked.map((skill) => loadSkillContext(app, skill)));
  return { text: `[Skills the user invoked with /name; follow them for this request:]\n${loaded.map(skill => skill.text).join("\n\n")}`,
    images: [], files: [], instructionPaths: [...new Set(loaded.flatMap(skill => skill.paths))] };
}

/** The `/name` being typed: a `/` at the start of a line or after a space, up to the caret. */
export function skillAt(text: string, caret: number): { start: number; query: string } | null {
  const match = /(?:^|\s)\/([\p{L}\p{N}_.-]*)$/u.exec(text.slice(text.lastIndexOf("\n", caret - 1) + 1, caret));
  if (!match) return null;
  return { start: caret - match[1].length - 1, query: match[1] };
}

/** Skills that match `query` (fuzzy on the name, best first); all for an empty one. */
export function skillCandidates(skills: Skill[], query: string): Skill[] {
  if (!query) return skills.slice(0, CANDIDATES);
  const match = prepareFuzzySearch(query);
  return skills
    .map((skill) => ({ skill, score: match(skill.name)?.score }))
    .filter((item): item is { skill: Skill; score: number } => item.score !== undefined)
    .sort((a, b) => b.score - a.score)
    .slice(0, CANDIDATES)
    .map((item) => item.skill);
}

export function normalizeSkillPreferences(value: unknown): Record<string, SkillPreference> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const preferences: Record<string, SkillPreference> = {};
  for (const [path, raw] of Object.entries(value as Record<string, unknown>)) {
    if (!path || path === "__proto__" || path === "prototype" || path === "constructor") continue;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    if (typeof (raw as Record<string, unknown>).enabled === "boolean") {
      preferences[path] = { enabled: (raw as Record<string, boolean>).enabled };
    }
  }
  return preferences;
}

/** A SKILL.md to start from, for "New skill" in the settings. */
export const SKILL_TEMPLATE = (name: string) => `---
name: ${name}
description: What this skill does and when to use it, in one or two sentences. The AI picks the skill by this.
---

Write the instructions here, as steps or rules. Other files in this folder (templates, examples) can be named here; the AI reads them when needed.
`;
