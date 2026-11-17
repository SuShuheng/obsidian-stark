import { App, TFile, TFolder, getFrontMatterInfo, normalizePath, prepareFuzzySearch } from "obsidian";
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

/** Every skill in `folder`: each subfolder with a SKILL.md, by name. */
export function allSkills(app: App, folder: string): Skill[] {
  const key = skillsFolder(folder);
  const root = app.vault.getFolderByPath(key);
  if (!(root instanceof TFolder)) return hiddenSkillsFor(app).get(key) ?? [];
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
  const sorted = skills.sort((a, b) => a.name.localeCompare(b.name));
  hiddenSkillsFor(app).set(key, sorted);
  return sorted;
}

/** Scan the live Vault index, then the adapter for hidden folders such as `.agents/skills`. */
export async function refreshSkills(app: App, folder: string): Promise<Skill[]> {
  const key = skillsFolder(folder);
  const root = app.vault.getFolderByPath(key);
  const visible = allSkills(app, key);
  if (root instanceof TFolder && visible.length) return visible;
  const adapter = app.vault.adapter;
  if (!adapter?.list) return visible;
  let listing: { files: string[]; folders: string[] };
  try {
    listing = await adapter.list(key);
  } catch {
    return visible;
  }
  const skills: Skill[] = [];
  for (const directory of listing.folders) {
    const path = `${directory}/${SKILL_FILE}`;
    try {
      if (!(await adapter.exists(path))) continue;
      const text = await adapter.read(path);
      const properties = frontMatterValues(text);
      skills.push({
        name: properties.name?.trim() || directory.split("/").pop() || directory,
        description: properties.description?.trim() || "",
        path,
      });
    } catch {
      // A removed or unreadable skill doesn't hide the others.
    }
  }
  const sorted = skills.sort((a, b) => a.name.localeCompare(b.name));
  hiddenSkillsFor(app).set(key, sorted);
  return sorted;
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
  const listing = await app.vault.adapter.list(folder);
  const files = [...listing.files];
  for (const child of listing.folders) files.push(...await filesInAdapter(app, child));
  return files.sort();
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
