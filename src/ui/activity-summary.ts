export type ActivityLanguage = "zh" | "en";

export type ActivityKind =
  | "read"
  | "search"
  | "edit"
  | "create"
  | "delete"
  | "command"
  | "web"
  | "skill"
  | "ask"
  | "tool";

export interface ActivityEntry {
  name: string;
  state: "running" | "done" | "error";
  input?: Record<string, unknown>;
}

const READING = new Set([
  "read_document",
  "read_file",
  "read_canvas",
  "read_web_page",
  "get_properties",
  "get_links",
  "get_backlinks",
  "open_document",
  "view_image",
  "view_canvas",
]);

const SEARCHING = new Set([
  "search_vault",
  "query_notes",
  "list_files",
  "list_metadata",
]);

const EDITING = new Set([
  "edit_document",
  "edit_canvas",
  "set_properties",
  "rename_file",
]);

const CREATING = new Set(["create_file"]);
const DELETING = new Set(["delete_file"]);
const WEB = new Set(["web_search", "web_fetch"]);
const SKILLS = new Set(["use_skill"]);
const QUESTIONS = new Set(["ask_user", "request_user_input"]);

export function activityKind(name: string): ActivityKind {
  if (READING.has(name)) return "read";
  if (SEARCHING.has(name)) return "search";
  if (EDITING.has(name)) return "edit";
  if (CREATING.has(name)) return "create";
  if (DELETING.has(name)) return "delete";
  if (WEB.has(name)) return "web";
  if (SKILLS.has(name)) return "skill";
  if (QUESTIONS.has(name)) return "ask";
  if (
    name === "get_current_datetime" ||
    name.startsWith("terminal_") ||
    name.startsWith("exec_") ||
    name.startsWith("mcp_")
  ) {
    return "command";
  }
  return "tool";
}

const RUNNING_LABELS: Record<ActivityKind, readonly [string, string]> = {
  read: ["正在读取", "Reading"],
  search: ["正在搜索代码", "Searching code"],
  edit: ["正在编辑", "Editing"],
  create: ["正在创建", "Creating"],
  delete: ["正在删除", "Deleting"],
  command: ["正在运行命令", "Running a command"],
  web: ["正在浏览网页", "Browsing the web"],
  skill: ["正在使用技能", "Using a skill"],
  ask: ["正在等待回答", "Waiting for an answer"],
  tool: ["正在使用工具", "Using a tool"],
};

const DONE_LABELS: Record<ActivityKind, readonly [string, string]> = {
  read: ["已读取文件", "read files"],
  search: ["已搜索代码", "searched code"],
  edit: ["已编辑文件", "edited files"],
  create: ["已创建文件", "created files"],
  delete: ["已删除文件", "deleted files"],
  command: ["执行了命令", "ran commands"],
  web: ["已浏览网页", "browsed the web"],
  skill: ["使用了技能", "used skills"],
  ask: ["已询问用户", "asked the user"],
  tool: ["使用了工具", "used tools"],
};

const DETAIL_KEYS = [
  "query",
  "q",
  "pattern",
  "path",
  "file",
  "filePath",
  "filename",
  "folder",
  "new_path",
  "name",
  "title",
  "url",
  "command",
  "cmd",
  "question",
  "skill",
  "skillName",
  "target",
] as const;

export function activityDetail(input: Record<string, unknown> | undefined): string {
  if (!input) return "";
  for (const key of DETAIL_KEYS) {
    const value = input[key];
    if (typeof value === "string" && value.trim() !== "") {
      return value.replace(/\s+/g, " ").trim().slice(0, 100);
    }
    if (Array.isArray(value) && value.every((item) => typeof item === "string")) {
      const text = value.join(", ").trim();
      if (text !== "") return text.slice(0, 100);
    }
  }
  return "";
}

function label(
  labels: Record<ActivityKind, readonly [string, string]>,
  kind: ActivityKind,
  language: ActivityLanguage,
): string {
  return labels[kind][language === "zh" ? 0 : 1];
}

const COMPLETED_ORDER: readonly ActivityKind[] = [
  "command",
  "search",
  "read",
  "edit",
  "create",
  "delete",
  "web",
  "skill",
  "ask",
  "tool",
];

export function liveActivityLabel(entries: readonly ActivityEntry[], language: ActivityLanguage): string {
  if (entries.length === 0) return language === "zh" ? "正在处理" : "Working";
  const latest = [...entries].reverse().find((entry) => entry.state === "running") ?? entries[entries.length - 1];
  if (!latest) return language === "zh" ? "正在处理" : "Working";
  const verb = label(RUNNING_LABELS, activityKind(latest.name), language);
  const detail = activityDetail(latest.input);
  return detail === "" ? verb : `${verb} · ${detail}`;
}

export function completedActivityLabel(entries: readonly ActivityEntry[], language: ActivityLanguage): string {
  const seen = new Set<ActivityKind>();
  for (const entry of entries) seen.add(activityKind(entry.name));
  if (seen.size === 0) return language === "zh" ? "已完成" : "Finished";

  const ranked = COMPLETED_ORDER
    .filter((kind) => seen.has(kind))
    .map((kind) => label(DONE_LABELS, kind, language));

  const shown = ranked.slice(0, 3);
  let summary: string;
  if (language === "zh") {
    summary = shown.join("，");
    if (ranked.length > 3) summary += "等";
  } else {
    summary = shown.length <= 1
      ? shown[0] ?? "Finished"
      : `${shown.slice(0, -1).join(", ")} and ${shown[shown.length - 1]}`;
    if (ranked.length > 3) summary += " and more";
    summary = summary.charAt(0).toUpperCase() + summary.slice(1);
  }

  const failed = entries.filter((entry) => entry.state === "error").length;
  if (failed > 0) {
    summary += language === "zh" ? ` · ${failed} 个操作失败` : ` · ${failed} failed`;
  }
  return summary;
}
