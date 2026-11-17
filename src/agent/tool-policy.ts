import type { ChatSettings, ToolPermission, ToolPreference, UnifiedToolDef } from "../types";
import { TOOL_DEFINITIONS } from "../tools/registry";

export interface ToolCatalogItem {
  name: string;
  /** English source text, translated by the settings UI. */
  label: string;
  /** English source text, translated by the settings UI. */
  description: string;
  /** English source text, translated by the settings UI. */
  category: string;
}

/** Short, UI-facing descriptions; the model gets the full registry text. */
export const TOOL_CATALOG: ToolCatalogItem[] = [
  { name: "read_document", label: "Read note", description: "Read a Markdown note or the active note.", category: "Notes and files" },
  { name: "edit_document", label: "Edit note", description: "Replace, insert or update text in a note.", category: "Notes and files" },
  { name: "search_vault", label: "Search vault", description: "Find notes and canvases by name or content.", category: "Notes and files" },
  { name: "read_file", label: "Read file", description: "Read text, PDF, Word, Excel or PowerPoint files.", category: "Notes and files" },
  { name: "view_image", label: "View image", description: "Look at an image in the vault.", category: "Notes and files" },
  { name: "create_file", label: "Create file", description: "Create a new note or other file.", category: "Notes and files" },
  { name: "list_files", label: "List files", description: "List vault files, optionally by folder or extension.", category: "Notes and files" },
  { name: "rename_file", label: "Rename or move file", description: "Rename a file or move it to another folder.", category: "Notes and files" },
  { name: "delete_file", label: "Delete file", description: "Move a file to Obsidian's trash.", category: "Notes and files" },
  { name: "read_canvas", label: "Read canvas", description: "Read a canvas as a compact outline.", category: "Canvas" },
  { name: "view_canvas", label: "View canvas", description: "Render a canvas as a picture.", category: "Canvas" },
  { name: "edit_canvas", label: "Edit canvas", description: "Add, update, move or remove canvas cards and edges.", category: "Canvas" },
  { name: "get_properties", label: "Read properties", description: "Read a note's YAML properties.", category: "Metadata and links" },
  { name: "set_properties", label: "Set properties", description: "Change a note's YAML properties.", category: "Metadata and links" },
  { name: "query_notes", label: "Query notes", description: "Find notes by tags, properties, folder or date.", category: "Metadata and links" },
  { name: "list_metadata", label: "List metadata", description: "List the vault's tags and property names.", category: "Metadata and links" },
  { name: "get_links", label: "Read links", description: "Read backlinks, mentions and outgoing links.", category: "Metadata and links" },
  { name: "open_document", label: "Open document", description: "Open a note or canvas for the user.", category: "Vault and web" },
  { name: "get_current_datetime", label: "Current date and time", description: "Read the local date and time.", category: "Vault and web" },
  { name: "read_web_page", label: "Read web page", description: "Read a web page as Markdown.", category: "Vault and web" },
  { name: "use_skill", label: "Use skill", description: "Load instructions from an enabled Vault skill.", category: "Skills and interaction" },
  { name: "ask_user", label: "Ask the user", description: "Pause the task and ask a clarifying question.", category: "Skills and interaction" },
];

const CATALOG = new Map(TOOL_CATALOG.map((item) => [item.name, item]));

export function toolCatalogItem(name: string): ToolCatalogItem {
  return CATALOG.get(name) ?? {
    name,
    label: name,
    description: "A tool registered by Stark.",
    category: "Other",
  };
}

export function toolPreference(settings: ChatSettings, name: string): ToolPreference {
  return settings.toolPreferences?.[name] ?? {};
}

export function toolEnabled(settings: ChatSettings, name: string): boolean {
  return toolPreference(settings, name).enabled !== false;
}

export function toolPermission(settings: ChatSettings, name: string): ToolPermission {
  return toolPreference(settings, name).permission ?? settings.defaultToolPermission ?? "direct";
}

/** Tools the model may see for this turn. */
export function enabledToolDefinitions(settings: ChatSettings): UnifiedToolDef[] {
  return TOOL_DEFINITIONS.filter((tool) => toolEnabled(settings, tool.name));
}

export function normalizeToolPreferences(value: unknown): Record<string, ToolPreference> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const preferences: Record<string, ToolPreference> = {};
  for (const [name, raw] of Object.entries(value as Record<string, unknown>)) {
    if (!name || name === "__proto__" || name === "prototype" || name === "constructor") continue;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const record = raw as Record<string, unknown>;
    const preference: ToolPreference = {};
    if (typeof record.enabled === "boolean") preference.enabled = record.enabled;
    if (record.permission === "direct" || record.permission === "ask") preference.permission = record.permission;
    if (Object.keys(preference).length) preferences[name] = preference;
  }
  return preferences;
}
