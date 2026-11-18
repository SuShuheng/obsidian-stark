import { App, Modal, Notice, Platform, PluginSettingTab, Setting, SliderComponent, normalizePath, requireApiVersion, type SettingDefinition, type SettingDefinitionItem } from "obsidian";
import type ChatPlugin from "./main";
import type { ChatSettings, McpServer, ModelPreference, Provider, ToolPermission, VoiceMicMode } from "./types";
import type { BrowserLogin } from "./auth/chatgptBrowserLogin";
import type { ChatGPTDeviceAuthorization, PollHandle } from "./auth/chatgptOAuth";
import { clearDebugLog } from "./debug";
import { INSTRUCTIONS_FILE } from "./agent/instructions";
import {
  allSkills,
  DEFAULT_SKILLS_FOLDER,
  mirrorSkillsForMobile,
  MOBILE_SKILLS_FOLDER,
  refreshSkills,
  SKILL_FILE,
  SKILL_TEMPLATE,
  skillEnabled,
  type Skill,
} from "./agent/skills";
import { validServerName, validServerUrl } from "./api/mcp";
import { DEFAULT_COMPACT_PERCENT, MIN_COMPACT_PERCENT, compactThreshold, defaultCompactThreshold } from "./agent/compaction";
import { formatTokens } from "./agent/usage";
import { formatBytes } from "./images";
import { VOICES } from "./voice/codex";
import { resolveLanguage, thinkingLevelName, translate, type Language } from "./i18n";
import { effectiveModelOption, modelEnabled, validContextWindow } from "./model-preferences";
import { toolCatalogItem, toolPermission, toolPreference } from "./agent/tool-policy";
import { TOOL_DEFINITIONS } from "./tools/registry";
import { STARK_REPOSITORY_URL, checkLatestRelease, type UpdateResult } from "./about";
import { normalizeProxyUrl } from "./api/system-proxy";

import { type ModelOption, type CatalogState, catalogIdentity, cachedCatalog, refreshCatalog, getCatalogModels, clearCatalogModels, catalogModel, catalogDefaultLevel, resolveThinkingLevel, CATALOG_TTL } from "./api/model-catalog";

/** The MCP heading row's name, in its definition and on the row (MCP is an acronym). */
const MCP_SERVERS = "MCP servers";

type SettingsPageName = "general" | "models" | "chat" | "knowledge" | "agent" | "voice" | "data" | "about";

/** A new AGENTS.md: a comment saying what goes in it (the AI reads it too, harmlessly). */
const INSTRUCTIONS_TEMPLATE = "<!-- Instructions for AI assistants working in this vault (Stark and other tools that read AGENTS.md). Write each instruction as a plain sentence below. -->\n\n";

/** Models available to the in-chat selector: only the live/cached API catalog. */
export function getAvailableModelOptions(provider: Provider, settings?: ChatSettings): ModelOption[] {
  const models = getCatalogModels(provider) ?? [];
  return settings
    ? models.filter((model) => model.value === settings.model || modelEnabled(settings, model.value))
    : models;
}



/** Resolve a model ID to its display name */
export function getModelDisplayName(provider: string, modelId: string): string {
  const models = getCatalogModels(provider as Provider) ?? [];
  const match = models.find((m) => m.value === modelId);
  return match?.label || modelId;
}

/** Chat composer: the model name, plus the effective thinking level when the model offers levels. */
export function getModelHeaderLabel(provider: Provider, modelId: string, level: string, language: Language = "en"): string {
  const option = catalogModel(provider, modelId);
  const name = getModelDisplayName(provider, modelId);
  const efforts = option?.reasoningEfforts;
  if (!efforts?.length) return name;
  const effective = resolveThinkingLevel(option, level)
    ?? catalogDefaultLevel(option)
    ?? (efforts.includes("medium") ? "medium" : efforts[0]);
  return `${name} · ${thinkingLevelName(language, effective)}`;
}

/** A token number as typed: "160000", "160 000", "160k", "1.2M"; null when empty or not a number. */
export function parseTokens(value: string): number | null {
  const match = /^([\d.,]+)\s*([km]?)$/i.exec(value.replace(/[\s_']/g, ""));
  if (!match) return null;
  const number = Number.parseFloat(match[1].replace(/,/g, ""));
  const scale = match[2].toLowerCase() === "m" ? 1_000_000 : match[2].toLowerCase() === "k" ? 1000 : 1;
  return Number.isFinite(number) && number > 0 ? Math.round(number * scale) : null;
}

/**
 * Settings for the Test buttons: one word back, as fast as the model allows.
 * No web search, no MCP servers and the lightest thinking level the catalog
 * lists (providers list them lightest first); the chat settings stay as they are.
 */
function connectionTestSettings(settings: ChatSettings): ChatSettings {
  const efforts = catalogModel(settings.provider, settings.model)?.reasoningEfforts;
  return { ...settings, enableWebSearch: false, mcpServers: [], thinkingLevel: efforts?.[0] ?? settings.thinkingLevel };
}

// ─── Settings Tab ───────────────────────────────────────────────────────────

export class ChatSettingTab extends PluginSettingTab {
  plugin: ChatPlugin;
  private catalogModels?: ModelOption[];
  private catalogIdentity = "";
  private loadingCatalog = false;
  private catalogError = "";
  private apiKeyEditing = false;
  private apiKeyTimer?: number;
  /** Set while the tab is closed, so pending redraws (timers, model list loads) skip it. */
  private hidden = false;
  private checkingUpdate = false;
  private updateResult?: UpdateResult;
  /** The selected page before Obsidian 1.13 (newer versions navigate pages natively). */
  private activePage: SettingsPageName = "general";

  private get language(): Language {
    return resolveLanguage(this.plugin.settings.language);
  }

  private skillsScan?: Promise<void>;

  private t(source: string, variables?: Record<string, string | number>): string {
    return translate(this.language, source, variables);
  }

  constructor(app: App, plugin: ChatPlugin) {
    super(app, plugin);
    this.plugin = plugin;
    // Scopes the wrapping rows in styles.css (several buttons on a phone).
    this.containerEl.addClass("ochatting-settings");
  }

  hide(): void {
    super.hide();
    this.hidden = true;
  }

  // Obsidian 1.13+ renders these pages as native settings navigation; older
  // versions draw the same set as tabs in display().
  getSettingDefinitions(): SettingDefinitionItem[] {
    this.hidden = false;
    void this.refreshSkillsOnce();
    return [
      {
        type: "page",
        name: this.t("General"),
        items: [
          { name: this.t("Plugin language"), render: setting => this.renderLanguage(setting) },
          { name: this.t("Default chat location"), aliases: ["Sidebar", "Tab", "Layout"], render: setting => this.renderChatOpenLocation(setting) },
          { name: this.t("ChatGPT account"), render: setting => this.renderChatGPTOAuthSection(setting.settingEl.parentElement!, setting) },
          { name: this.t("Network and streaming"), render: setting => this.renderNetworkInfo(setting) },
        ],
      },
      {
        type: "page",
        name: this.t("Models"),
        items: [
          { name: this.t("Model catalog"), aliases: ["Refresh models"], render: setting => {
            this.renderModelCatalogStatus(setting);
            void this.loadCatalog(false);
          } },
          ...this.modelPreferenceItems(),
        ],
      },
      {
        type: "page",
        name: this.t("Chat"),
        items: [
          { name: this.t("Web search"), render: setting => this.renderWebSearch(setting) },
          { name: this.t("Enter sends message"), aliases: ["Keyboard", "New line"], render: setting => this.renderEnterSends(setting) },
          { name: this.t("Follow the AI's edits"), aliases: ["Show edits", "Highlight"], render: setting => this.renderFollowEdits(setting) },
          { name: this.t("Max tool iterations"), render: setting => this.renderMaxIterations(setting) },
          { name: this.t("Compaction point"), aliases: ["Context", "Summarize", "Compact"], render: setting => this.renderCompactionPoint(setting) },
        ],
      },
      {
        type: "page",
        name: this.t("Knowledge"),
        items: [
          { name: this.t("Vault instructions"), aliases: ["AGENTS.md", "Instructions"], render: setting => this.renderInstructions(setting) },
        ],
      },
      {
        type: "page",
        name: this.t("Agent"),
        items: [
          { name: this.t("Default tool permission"), render: setting => this.renderDefaultToolPermission(setting) },
          { type: "group", heading: this.t("Tools"), items: this.toolPreferenceItems() },
          { name: this.t("Skills folder"), aliases: ["Skill", "SKILL.md", ".agents/skills"], render: setting => this.renderSkillsFolder(setting) },
          { name: this.t("Mobile Skills mirror"), aliases: ["Skill", "Mobile", ".agents/skills"], render: setting => this.renderMobileSkillsMirror(setting) },
          ...this.skillPreferenceItems(),
          { name: this.t("New skill"), render: setting => this.renderNewSkill(setting, allSkills(this.app, this.plugin.settings.skillsFolder).length === 0) },
        ],
      },
      {
        type: "page",
        name: this.t("Voice"),
        items: [
          { type: "group", heading: this.t("Voice"), items: [
            { name: this.t("ChatGPT account for voice"), aliases: ["ChatGPT plan", "Codex"], render: setting => this.renderVoiceAccount(setting) },
            { name: this.t("Voice"), render: setting => this.renderVoiceName(setting) },
            { name: this.t("Microphone"), aliases: ["Hold to talk", "Hands-free"], render: setting => this.renderMicMode(setting) },
          ] },
        ],
      },
      {
        type: "page",
        name: this.t("Data & diagnostics"),
        items: [
          { name: this.t("Saved chats"), aliases: ["Chat history", "Storage"], render: setting => this.renderSavedChats(setting) },
          { name: this.t("Debug log"), aliases: ["Troubleshooting"], render: setting => this.renderDebugLog(setting) },
          { name: this.t("Device capabilities"), render: setting => this.renderCapabilityCheck(setting) },
        ],
      },
      {
        type: "page",
        name: this.t("About"),
        items: [
          { name: this.t("Plugin information"), render: setting => this.renderAboutInfo(setting) },
          { name: this.t("Updates"), render: setting => this.renderAboutUpdates(setting) },
        ],
      },
    ];
  }

  /** Flattened definitions for tests and compatibility checks. */
  getAllSettingDefinitions(): SettingDefinitionItem[] {
    return this.getSettingDefinitions().flatMap((item) =>
      "type" in item && item.type === "page" ? item.items ?? [] : [item]);
  }

  private refreshSettingsTab(): void {
    if (this.hidden) return;
    if (requireApiVersion("1.13.0")) this.update();
    else this.display();
  }

  /**
   * The hidden `.agents/skills` folder is visible only to the adapter. Scan
   * once, then redraw if the cached list changed.
   */
  private refreshSkillsOnce(): Promise<void> {
    if (this.skillsScan) return this.skillsScan;
    const folder = this.plugin.settings.skillsFolder;
    const before = JSON.stringify(allSkills(this.app, folder));
    this.skillsScan = refreshSkills(this.app, folder)
      .then(() => {
        if (this.plugin.settings.skillsFolder !== folder) return;
        const after = JSON.stringify(allSkills(this.app, folder));
        if (before !== after && !this.hidden) this.refreshSettingsTab();
      })
      .catch(() => undefined)
      .finally(() => { this.skillsScan = undefined; });
    return this.skillsScan;
  }

  display(): void {
    this.hidden = false;
    void this.refreshSkillsOnce();
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl("h2", { text: "Stark" });
    const tabs = containerEl.createDiv({ cls: "stark-settings-tabs", attr: { role: "tablist" } });
    const pages: Array<{ id: SettingsPageName; label: string }> = [
      { id: "general", label: this.t("General") },
      { id: "models", label: this.t("Models") },
      { id: "chat", label: this.t("Chat") },
      { id: "knowledge", label: this.t("Knowledge") },
      { id: "agent", label: this.t("Agent") },
      { id: "voice", label: this.t("Voice") },
      { id: "data", label: this.t("Data & diagnostics") },
      { id: "about", label: this.t("About") },
    ];
    for (const page of pages) {
      const button = tabs.createEl("button", {
        text: page.label,
        attr: { type: "button", role: "tab", "aria-selected": String(page.id === this.activePage) },
      });
      button.addClass("stark-settings-tab");
      if (page.id === this.activePage) button.addClass("is-active");
      button.addEventListener("click", () => {
        this.activePage = page.id;
        this.display();
      });
    }
    const body = containerEl.createDiv({ cls: "stark-settings-page", attr: { role: "tabpanel" } });
    this.renderPage(body);
  }

  private renderPage(containerEl: HTMLElement): void {
    switch (this.activePage) {
      case "general":
        this.renderLanguage(new Setting(containerEl));
        this.renderChatGPTOAuthSection(containerEl);
        this.renderNetworkInfo(new Setting(containerEl));
        break;
      case "models":
        this.renderModels(containerEl);
        break;
      case "chat":
        this.renderWebSearch(new Setting(containerEl));
        this.renderEnterSends(new Setting(containerEl));
        this.renderFollowEdits(new Setting(containerEl));
        this.renderMaxIterations(new Setting(containerEl));
        this.renderCompactionPoint(new Setting(containerEl));
        break;
      case "knowledge":
        this.renderInstructions(new Setting(containerEl));
        break;
      case "agent":
        this.renderAgent(containerEl);
        break;
      case "voice":
        this.renderVoice(containerEl);
        break;
      case "data":
        this.renderSavedChats(new Setting(containerEl));
        this.renderDebugLog(new Setting(containerEl));
        this.renderCapabilityCheck(new Setting(containerEl));
        break;
      case "about":
        this.renderAboutInfo(new Setting(containerEl));
        this.renderAboutUpdates(new Setting(containerEl));
        break;
    }
  }

  private renderLanguage(setting: Setting): void {
    const s = this.plugin.settings;
    setting
      .setName(this.t("Plugin language"))
      .setDesc(this.t("Choose the language used by Stark. Automatic follows Obsidian's language."))
      .addDropdown((dropdown) =>
        dropdown
          .addOption("auto", this.t("Automatic"))
          .addOption("zh", this.t("Simplified Chinese"))
          .addOption("en", "English")
          .setValue(s.language)
          .onChange(async (value) => {
            s.language = value === "zh" || value === "en" ? value : "auto";
            await this.plugin.saveSettings();
            this.refreshSettingsTab();
          })
      );
  }

  private renderChatOpenLocation(setting: Setting): void {
    const s = this.plugin.settings;
    setting
      .setName(this.t("Default chat location"))
      .setDesc(this.t("Choose where the ribbon and Open chat command show Stark. The explicit sidebar and new-tab commands remain available."))
      .addDropdown((dropdown) =>
        dropdown
          .addOption("sidebar", this.t("Right sidebar"))
          .addOption("tab", this.t("Main editor tab"))
          .setValue(s.chatOpenLocation === "tab" ? "tab" : "sidebar")
          .onChange(async (value) => {
            s.chatOpenLocation = value === "tab" ? "tab" : "sidebar";
            await this.plugin.saveSettings();
          })
      );
  }

  private renderWebSearch(setting: Setting): void {
    const s = this.plugin.settings;
    setting
      .setName(this.t("Web search"))
      .setDesc(this.t("Allow the model to search the web when it needs current information"))
      .addToggle((toggle) =>
        toggle
          .setValue(s.enableWebSearch)
          .onChange(async (value) => {
            s.enableWebSearch = value;
            await this.plugin.saveSettings();
          })
      );

  }
  private renderEnterSends(setting: Setting): void {
    const s = this.plugin.settings;
    setting
      .setName(this.t("Enter sends message"))
      .setDesc(this.t("On: Enter sends, Shift+Enter starts a new line. Off: Enter starts a new line; send with the send button or Ctrl+Enter (Cmd+Enter on a Mac)."))
      .addToggle((toggle) =>
        toggle
          .setValue(s.enterSends)
          .onChange(async (value) => {
            s.enterSends = value;
            await this.plugin.saveSettings();
          })
      );
  }
  private renderFollowEdits(setting: Setting): void {
    const s = this.plugin.settings;
    setting
      .setName(this.t("Follow the AI's edits"))
      .setDesc(this.t("When the AI changes a note or canvas, it opens next to the chat at the changed spot: changed text is highlighted, changed canvas cards are selected. Also the eye button in the chat header."))
      .addToggle((toggle) =>
        toggle
          .setValue(s.followEdits)
          .onChange(async (value) => {
            s.followEdits = value;
            await this.plugin.saveSettings();
          })
      );
  }
  /** AGENTS.md at the vault root: open it, or create it first. */
  private renderInstructions(setting: Setting): void {
    const exists = !!this.app.vault.getFileByPath(INSTRUCTIONS_FILE);
    setting
      .setName(this.t("Vault instructions"))
      .setDesc(this.t("Standing instructions for the AI, in {file} at the vault root; every chat follows them. A folder can have its own {file} for its notes.{missing}", {
        file: INSTRUCTIONS_FILE,
        missing: exists ? "" : this.t(" There is none yet."),
      }))
      .addButton((button) => button.setButtonText(this.t(exists ? "Open" : "Create")).onClick(async () => {
        const file = this.app.vault.getFileByPath(INSTRUCTIONS_FILE)
          ?? await this.app.vault.create(INSTRUCTIONS_FILE, INSTRUCTIONS_TEMPLATE);
        await this.app.workspace.getLeaf("tab").openFile(file);
        this.refreshSettingsTab();
      }));
  }

  // ─── Skills ────────────────────────────────────────────────────────────

  /** The skills folder; the skills found there are listed below it. */
  private renderSkillsFolder(setting: Setting): void {
    const s = this.plugin.settings;
    setting
      .setName(this.t("Skills folder"))
      .setDesc(this.t("Instructions for particular tasks, a folder each with a SKILL.md, in this vault folder. The default is .agents/skills, shared with other agent tools in this repository."))
      .addText((text) => {
        text.setPlaceholder(DEFAULT_SKILLS_FOLDER).setValue(s.skillsFolder).onChange(async (value) => {
          s.skillsFolder = value.trim() || DEFAULT_SKILLS_FOLDER;
          await this.plugin.saveSettings();
        });
        // The list follows once the name is typed.
        text.inputEl.addEventListener("blur", () => {
          this.refreshSettingsTab();
          const before = JSON.stringify(allSkills(this.app, s.skillsFolder));
          void refreshSkills(this.app, s.skillsFolder).then(() => {
            if (before !== JSON.stringify(allSkills(this.app, s.skillsFolder))) this.refreshSettingsTab();
          }).catch(() => undefined);
        });
      })
      .addButton((button) => button.setButtonText(this.t("Use default")).onClick(async () => {
        s.skillsFolder = DEFAULT_SKILLS_FOLDER;
        await this.plugin.saveSettings();
        await refreshSkills(this.app, s.skillsFolder).catch(() => undefined);
        this.refreshSettingsTab();
      }))
      .addButton((button) => button.setIcon("refresh-cw").setTooltip(this.t("Scan now")).onClick(async () => {
        await refreshSkills(this.app, s.skillsFolder).catch(() => undefined);
        this.refreshSettingsTab();
        const found = allSkills(this.app, s.skillsFolder).length;
        new Notice(this.t("Found {count} skills.", { count: found }));
      }));
  }

  /**
   * Dot folders are hidden from Obsidian's mobile adapter and are not copied
   * by Obsidian Sync. A visible mirror gives mobile the same skills.
   */
  private renderMobileSkillsMirror(setting: Setting): void {
    const s = this.plugin.settings;
    setting
      .setName(this.t("Mobile Skills mirror"))
      .setDesc(this.t("Obsidian mobile cannot reliably read hidden folders such as .agents/skills. Stark falls back to the visible {folder} folder; sync the current skills there before using them on mobile.", {
        folder: MOBILE_SKILLS_FOLDER,
      }))
      .addButton((button) => button
        .setButtonText(this.t("Sync for mobile"))
        .onClick(async () => {
          try {
            const count = await mirrorSkillsForMobile(this.app, s.skillsFolder);
            await refreshSkills(this.app, s.skillsFolder).catch(() => undefined);
            new Notice(count
              ? this.t("Copied {count} skills to {folder}.", { count, folder: MOBILE_SKILLS_FOLDER })
              : this.t("No skills found in {folder}.", { folder: s.skillsFolder }));
            this.refreshSettingsTab();
          } catch (error) {
            new Notice(this.t("Could not copy skills to {folder}: {error}", {
              folder: MOBILE_SKILLS_FOLDER,
              error: error instanceof Error ? error.message : String(error),
            }));
          }
        }));
  }

  private skillPreferenceItems(): SettingDefinition[] {
    const skills = allSkills(this.app, this.plugin.settings.skillsFolder);
    return skills.map((skill) => ({
      name: `/${skill.name}`,
      aliases: ["Skill", "SKILL.md"],
      render: (setting: Setting) => this.renderSkill(setting, skill),
    }));
  }

  private renderSkill(setting: Setting, skill: Skill): void {
    const s = this.plugin.settings;
    s.skillPreferences ??= {};
    const enabled = skillEnabled(s.skillPreferences, skill);
    setting
      .setName(`/${skill.name}`)
      .setDesc(skill.description || this.t("No description: the AI can't tell when to use it. Add one to its properties."))
      .addToggle((toggle) => toggle
        .setValue(enabled)
        .setTooltip(this.t("Enable this skill"))
        .onChange(async (value) => {
          s.skillPreferences ??= {};
          s.skillPreferences[skill.path] = { enabled: value };
          await this.plugin.saveSettings();
        }))
      .addExtraButton((button) => {
        const file = this.app.vault.getFileByPath(skill.path);
        button.setIcon("file-text")
          .setTooltip(file ? this.t("Open {path}", { path: skill.path }) : this.t("This skill is in a hidden folder and can't be opened here."))
          .setDisabled(!file)
          .onClick(() => { if (file) void this.app.workspace.getLeaf("tab").openFile(file); });
      });
  }

  private renderNewSkill(setting: Setting, empty: boolean): void {
    setting
      .setDesc(empty ? this.t("No skills in {folder}/ yet.", { folder: this.plugin.settings.skillsFolder }) : "")
      .addButton((button) => button.setButtonText(this.t("New skill")).onClick(() => void this.createSkill()));
  }

  /** A new skill folder with a SKILL.md from the template, opened in a new tab. */
  private async createSkill(): Promise<void> {
    const folder = normalizePath(this.plugin.settings.skillsFolder || DEFAULT_SKILLS_FOLDER);
    let name = "new-skill";
    const adapter = this.app.vault.adapter;
    const hidden = !this.app.vault.getFolderByPath(folder) && typeof adapter?.mkdir === "function" && typeof adapter.write === "function";
    const exists = async (path: string) => hidden
      ? await adapter.exists(path).catch(() => false)
      : !!this.app.vault.getAbstractFileByPath(path);
    for (let i = 2; await exists(`${folder}/${name}`); i++) name = `new-skill-${i}`;
    for (const path of [folder, `${folder}/${name}`]) {
      if (await exists(path)) continue;
      if (hidden) await adapter.mkdir(path);
      else await this.app.vault.createFolder(path);
    }
    const path = `${folder}/${name}/${SKILL_FILE}`;
    if (hidden) {
      await adapter.write(path, SKILL_TEMPLATE(name));
      new Notice(this.t("Created {path}.", { path }));
    } else {
      const file = await this.app.vault.create(path, SKILL_TEMPLATE(name));
      await this.app.workspace.getLeaf("tab").openFile(file);
    }
    await refreshSkills(this.app, folder).catch(() => undefined);
    this.refreshSettingsTab();
  }

  // ─── Agent: tools and permissions ──────────────────────────────────────

  private renderAgent(containerEl: HTMLElement): void {
    this.renderDefaultToolPermission(new Setting(containerEl));
    new Setting(containerEl).setName(this.t("Tools")).setHeading();
    for (const tool of TOOL_DEFINITIONS) this.renderToolPreference(new Setting(containerEl), tool.name);
    new Setting(containerEl).setName(this.t("Skills")).setHeading();
    this.renderSkillsFolder(new Setting(containerEl));
    for (const skill of allSkills(this.app, this.plugin.settings.skillsFolder)) {
      this.renderSkill(new Setting(containerEl), skill);
    }
    this.renderNewSkill(new Setting(containerEl), allSkills(this.app, this.plugin.settings.skillsFolder).length === 0);
  }

  private renderDefaultToolPermission(setting: Setting): void {
    const s = this.plugin.settings;
    const defaultPermission: ToolPermission = s.defaultToolPermission ?? "direct";
    setting
      .setName(this.t("Default tool permission"))
      .setDesc(this.t("New tools follow this permission unless you override them below. Direct execution preserves the current agent behavior; user approval pauses before every call."))
      .addDropdown((dropdown) => dropdown
        .addOption("direct", this.t("Direct execution"))
        .addOption("ask", this.t("Require approval"))
        .setValue(defaultPermission)
        .onChange(async (value) => {
          s.defaultToolPermission = value === "ask" ? "ask" : "direct";
          await this.plugin.saveSettings();
          this.refreshSettingsTab();
        }));
  }

  private toolPreferenceItems(): SettingDefinition[] {
    return TOOL_DEFINITIONS.map((tool) => {
      const item = toolCatalogItem(tool.name);
      return {
        name: this.t(item.label),
        aliases: [tool.name],
        render: (setting: Setting) => this.renderToolPreference(setting, tool.name),
      };
    });
  }

  private renderToolPreference(setting: Setting, name: string): void {
    const s = this.plugin.settings;
    s.toolPreferences ??= {};
    const item = toolCatalogItem(name);
    const preference = toolPreference(s, name);
    const effective = toolPermission(s, name);
    const enabled = preference.enabled !== false;
    setting
      .setName(this.t(item.label))
      .setDesc(`${this.t(item.category)} · ${this.t(item.description)} · ${this.t(enabled ? "Enabled" : "Disabled")}`)
      .addToggle((toggle) => toggle
        .setValue(enabled)
        .setTooltip(this.t("Enable this tool"))
        .onChange(async (value) => {
          s.toolPreferences ??= {};
          s.toolPreferences[name] = { ...(s.toolPreferences[name] ?? {}), enabled: value };
          await this.plugin.saveSettings();
          this.refreshSettingsTab();
        }))
      .addDropdown((dropdown) => {
        dropdown
          .addOption("", this.t("Follow default ({permission})", { permission: this.t(effective === "ask" ? "Require approval" : "Direct execution") }))
          .addOption("direct", this.t("Direct execution"))
          .addOption("ask", this.t("Require approval"))
          .setValue(preference.permission ?? "")
          .setDisabled(name === "ask_user")
          .onChange(async (value) => {
            s.toolPreferences ??= {};
            const next = { ...(s.toolPreferences[name] ?? {}) };
            if (value === "direct" || value === "ask") next.permission = value;
            else delete next.permission;
            if (next.enabled === true) delete next.enabled;
            if (Object.keys(next).length) s.toolPreferences[name] = next;
            else delete s.toolPreferences[name];
            await this.plugin.saveSettings();
            this.refreshSettingsTab();
          });
      });
  }

  // ─── Network and diagnostics ───────────────────────────────────────────

  private renderNetworkInfo(setting: Setting): void {
    const s = this.plugin.settings;
    const desktop = Platform.isDesktopApp;
    const mode = desktop ? (s.networkProxyMode ?? "system") : "system";
    setting
      .setName(this.t("Network and streaming"))
      .setDesc(desktop
        ? this.t("Desktop answers stream through a direct connection or the system proxy. If a proxy cannot expose incremental data, Stark keeps the request and shows the completed answer.")
        : this.t("Mobile uses Obsidian's native network stack and the device's system proxy. When the WebView blocks incremental SSE, the answer is received in buffered mode and appears once complete."))
      .addDropdown((dropdown) => {
        dropdown.addOption("system", this.t("System proxy"));
        if (desktop) {
          dropdown.addOption("direct", this.t("Direct connection"));
          dropdown.addOption("manual", this.t("Manual proxy"));
        }
        dropdown
          .setValue(mode)
          .setDisabled(!desktop)
          .onChange(async (value) => {
            s.networkProxyMode = value === "manual" || value === "direct" ? value : "system";
            await this.plugin.saveSettings();
            this.refreshSettingsTab();
          });
      })
      .addText((text) => {
        text
          .setPlaceholder("http://127.0.0.1:7890")
          .setValue(s.networkProxyUrl ?? "")
          .setDisabled(!desktop || mode !== "manual");
        text.inputEl.addClass("stark-proxy-url-input");
        const commit = async () => {
          const entered = text.getValue().trim();
          if (!entered) {
            s.networkProxyUrl = "";
          } else {
            const normalized = normalizeProxyUrl(entered);
            if (!normalized) {
              new Notice(this.t("Enter an HTTP proxy address, for example http://127.0.0.1:7890."));
              text.setValue(s.networkProxyUrl ?? "");
              return;
            }
            s.networkProxyUrl = normalized;
            text.setValue(normalized);
          }
          await this.plugin.saveSettings();
        };
        text.inputEl.addEventListener("change", () => void commit());
        text.inputEl.addEventListener("keydown", (event) => {
          if (event.key === "Enter" && !event.isComposing) {
            event.preventDefault();
            void commit();
          }
        });
      });
  }

  private renderCapabilityCheck(setting: Setting): void {
    const platform = Platform.isDesktopApp
      ? this.t("Desktop: streaming is attempted before buffered fallback.")
      : this.t("Mobile: system proxy is used by Obsidian's native request; incremental streaming may fall back to buffered mode.");
    setting
      .setName(this.t("Device capabilities"))
      .setDesc(`${platform} ${this.t("Streaming is shown incrementally when the device and network permit it; otherwise the answer still completes normally.")}`);
  }

  // ─── About ─────────────────────────────────────────────────────────────

  private renderAboutInfo(setting: Setting): void {
    const manifest = this.plugin.manifest;
    const version = manifest?.version ?? "1.0.0";
    const author = manifest?.author ?? "GuoFan Zhang";
    setting
      .setName(this.t("Stark {version}", { version }))
      .setDesc(this.t("Author: {author}. GitHub repository: {url}", { author, url: STARK_REPOSITORY_URL }))
      .addButton((button) => button
        .setButtonText(this.t("Open GitHub"))
        .onClick(() => window.open(STARK_REPOSITORY_URL, "_blank")));
  }

  private renderAboutUpdates(setting: Setting): void {
    const version = this.plugin.manifest?.version ?? "1.0.0";
    const result = this.updateResult;
    const status = !result
      ? this.t("Check GitHub Releases for a newer version. Stark never downloads or installs an update automatically.")
      : result.status === "update"
        ? this.t("Version {version} is available on GitHub.", { version: result.release.version })
        : result.status === "current"
          ? this.t("You are using the latest GitHub Release ({version}).", { version: result.release.version })
          : result.status === "no-release"
            ? this.t("The repository has no published GitHub Release yet.")
            : this.t("Could not check GitHub Releases: {error}", { error: result.message });
    const row = setting
      .setName(this.t("Updates"))
      .setDesc(status)
      .addButton((button) => button
        .setButtonText(this.checkingUpdate ? this.t("Checking...") : this.t("Check for updates"))
        .setDisabled(this.checkingUpdate)
        .onClick(async () => {
          this.checkingUpdate = true;
          this.refreshSettingsTab();
          try {
            this.updateResult = await checkLatestRelease(version);
          } finally {
            this.checkingUpdate = false;
            this.refreshSettingsTab();
          }
        }));
    if (result?.status === "update") {
      row.addButton((button) => button
        .setButtonText(this.t("Open release"))
        .setCta()
        .onClick(() => window.open(result.release.url, "_blank")));
    }
  }

  private renderMaxIterations(setting: Setting): void {
    const s = this.plugin.settings;
    setting
      .setName(this.t("Max tool iterations"))
      .setDesc(this.t("Steps per answer before it pauses; Continue goes on (default: 20)"))
      .addText((text) =>
        text
          .setPlaceholder("20")
          .setValue(String(s.maxIterations))
          .onChange(async (value) => {
            const n = parseInt(value, 10);
            if (!isNaN(n) && n > 0 && n <= 100) {
              s.maxIterations = n;
              await this.plugin.saveSettings();
            }
          })
      );
  }

  // ─── Chats ─────────────────────────────────────────────────────────────

  /** Before Obsidian 1.13: the Chats heading and its rows (a group on 1.13+). */
  private renderChats(containerEl: HTMLElement): void {
    new Setting(containerEl).setName(this.t("Chats")).setHeading();
    this.renderCompactionPoint(new Setting(containerEl));
    this.renderSavedChats(new Setting(containerEl));
  }

  /** The compaction point: a percentage of the selected model's effective window. */
  private renderCompactionPoint(setting: Setting): void {
    const s = this.plugin.settings;
    const option = effectiveModelOption(s);
    const window = option?.contextWindow;
    const fallback = defaultCompactThreshold(s.provider, option);
    const defaultShare = window && fallback
      ? Math.min(100, Math.max(MIN_COMPACT_PERCENT, Math.round(fallback / window * 100)))
      : DEFAULT_COMPACT_PERCENT;
    setting.setName(this.t("Compaction point"));
    const describe = () => {
      const share = Math.min(100, Math.max(MIN_COMPACT_PERCENT, s.compactPercent ?? defaultShare));
      const point = window ? compactThreshold(s.provider, option, { compactPercent: share }) : undefined;
      const base = this.t("When a long chat is summarized, so it stays within the model's context. Earlier saves cost and time per answer; the model then keeps fewer details.");
      if (!window) {
        setting.setDesc(`${base} ${this.t("This model's context size is unknown. Set a context window on the Models page, then return here.")}`);
      } else {
        setting.setDesc(`${base} ${this.t("Now {share}% of the {window} context window (about {point}).", {
          share,
          window: formatTokens(window),
          point: formatTokens(point ?? 0),
        })}`);
      }
    };
    if (window) {
      const box = setting.controlEl.createDiv({ cls: "ochatting-compaction-box" });
      const above = box.createDiv({ cls: "ochatting-compaction-marks is-above" });
      const below = box.createDiv({ cls: "ochatting-compaction-marks" });
      const current = Math.min(100, Math.max(MIN_COMPACT_PERCENT, s.compactPercent ?? defaultShare));
      const slider = new SliderComponent(box)
        .setLimits(MIN_COMPACT_PERCENT, 100, 1)
        .setValue(current)
        .onChange(async (value) => {
          s.compactPercent = value === defaultShare ? null : value;
          describe();
          await this.plugin.saveSettings();
        });
      const mark = (marks: HTMLElement, at: number, text: string, cls: string) => {
        const el = marks.createSpan({ cls: `ochatting-compaction-mark ${cls}`, text });
        el.setCssProps({ "--ochatting-mark-at": `${(at - MIN_COMPACT_PERCENT) / (100 - MIN_COMPACT_PERCENT) * 100}%` });
      };
      mark(above, defaultShare, this.t("Default: {share}%", { share: defaultShare }), "is-default");
      mark(below, MIN_COMPACT_PERCENT, `${MIN_COMPACT_PERCENT}%`, "is-start");
      mark(below, 100, `100 % · ${formatTokens(window)}`, "is-end");
      void slider;
    }
    describe();
  }

  /** How many chats are saved and their size; large ones are marked in the chat list. */
  private renderSavedChats(setting: Setting): void {
    const { chats, bytes } = this.plugin.savedChatsSize();
    setting
      .setName(this.t("Saved chats"))
      .setDesc(this.t(chats === 1
        ? "1 chat, {size}, in the plugin's chats folder. A chat over 5 MB shows its size in the chat list; delete chats you no longer need there."
        : "{count} chats, {size}, in the plugin's chats folder. A chat over 5 MB shows its size in the chat list; delete chats you no longer need there.", {
        count: chats,
        size: formatBytes(bytes),
      }));
  }
  // ─── Voice ─────────────────────────────────────────────────────────────

  /** Before Obsidian 1.13: the Voice heading and its rows. */
  private renderVoice(containerEl: HTMLElement): void {
    new Setting(containerEl).setName(this.t("Voice")).setHeading();
    this.renderVoiceAccount(new Setting(containerEl));
    this.renderVoiceName(new Setting(containerEl));
    this.renderMicMode(new Setting(containerEl));
  }

  /** Voice uses the ChatGPT account sign-in (shared with the ChatGPT provider). */
  private renderVoiceAccount(setting: Setting): void {
    setting.setName(this.t("ChatGPT account for voice"));
    const credential = this.plugin.chatgptOAuth.getCredential();
    const what = this.t("Voice needs Codex voice access on your ChatGPT account. Availability and limits can differ from voice in the ChatGPT app. The work runs on the chat model you selected.");
    if (credential) {
      setting.setDesc(`${what} ${this.t("Connected (account {account}), the same sign-in as the ChatGPT provider.", {
        account: credential.accountId ? maskAccountId(credential.accountId) : "without an ID",
      })}`);
      return;
    }
    setting
      .setDesc(`${what} ${this.t("Not connected: it uses the same sign-in as the ChatGPT provider.")}`)
      .addButton((button) => button.setButtonText(this.t("Connect ChatGPT")).setCta().onClick(() => void this.connectChatGPT()));
  }

  private renderVoiceName(setting: Setting): void {
    const s = this.plugin.settings;
    setting
      .setName(this.t("Voice"))
      .setDesc(this.t("How the assistant sounds."))
      .addDropdown((dropdown) => {
        for (const voice of VOICES) dropdown.addOption(voice, voice.charAt(0).toUpperCase() + voice.slice(1));
        dropdown.setValue(s.voice).onChange(async (value) => {
          s.voice = value;
          await this.plugin.saveSettings();
        });
      });
  }

  private renderMicMode(setting: Setting): void {
    const s = this.plugin.settings;
    setting
      .setName(this.t("Microphone"))
      .setDesc(this.t("Hands-free: just talk; the voice answers when you pause. Hold to talk: the microphone is on only while you hold the button."))
      .addDropdown((dropdown) =>
        dropdown
          .addOption("hands-free", this.t("Hands-free"))
          .addOption("hold", this.t("Hold to talk"))
          .setValue(s.voiceMicMode)
          .onChange(async (value) => {
            s.voiceMicMode = value as VoiceMicMode;
            await this.plugin.saveSettings();
          })
      );
  }

  // ─── MCP servers ───────────────────────────────────────────────────────

  private renderMcpHeading(setting: Setting): void {
    setting
      .setName(MCP_SERVERS)
      .setDesc(this.plugin.settings.provider === "chatgpt-oauth"
        ? "Remote MCP servers work with an Anthropic or OpenAI API key. This plugin's ChatGPT account integration doesn't support remote MCP yet."
        : "Remote servers (public https) whose tools the AI can use. The provider connects to them and calls their tools without asking, so add only servers you trust.");
  }

  /** Obsidian 1.13+: the servers as a list, one row each; add and delete. */
  private mcpServerList(): SettingDefinitionItem {
    const s = this.plugin.settings;
    return {
      type: "list",
      emptyState: "No servers yet.",
      items: (s.mcpServers ?? []).map((server) => ({
        name: server.name || "New server",
        aliases: ["MCP"],
        render: (setting: Setting) => this.renderMcpServer(setting, server),
      })),
      onDelete: (index) => {
        const server = s.mcpServers[index];
        if (server) void this.removeMcpServer(server.id);
      },
      addItem: { name: "Add server", action: () => void this.addMcpServer() },
    };
  }

  /** Before Obsidian 1.13: the same as rows, each with a remove button, and Add server below them. */
  private renderMcpServers(containerEl: HTMLElement): void {
    this.renderMcpHeading(new Setting(containerEl));
    for (const server of this.plugin.settings.mcpServers ?? []) {
      this.renderMcpServer(new Setting(containerEl), server, true);
    }
    this.renderAddMcpServer(new Setting(containerEl));
  }

  /** One server's row: what is missing (or on/off), name, address, token, on/off; Remove where no list deletes it. */
  private renderMcpServer(setting: Setting, server: McpServer, removable = false): void {
    const s = this.plugin.settings;
    const status = () => {
      const problems = [
        ...(validServerName(server.name) ? [] : ["a name of letters, digits, - or _"]),
        ...(validServerUrl(server.url) ? [] : ["an https address"]),
      ];
      const duplicate = !!server.name && (s.mcpServers ?? []).some((other) => other !== server && other.name === server.name);
      setting.setName(server.name || "New server");
      setting.setDesc(problems.length ? `Needs ${problems.join(" and ")}.` : duplicate ? "Another server has this name." : server.enabled ? "On" : "Off");
    };
    const save = async () => {
      status();
      await this.plugin.saveSettings();
    };
    setting
      .setClass("ochatting-mcp-server")
      .addText((text) => text.setPlaceholder("Name").setValue(server.name).onChange(async (value) => {
        server.name = value.trim();
        await save();
      }))
      .addText((text) => text.setPlaceholder("https://…").setValue(server.url).onChange(async (value) => {
        server.url = value.trim();
        await save();
      }))
      .addText((text) => {
        text.inputEl.type = "password";
        text.setPlaceholder("Token (optional)").setValue(server.token ?? "").onChange(async (value) => {
          // Empty is an explicit deletion; undefined means not loaded on this device.
          server.token = value.trim();
          await save();
        });
      })
      .addToggle((toggle) => toggle.setValue(server.enabled).setTooltip("Use this server").onChange(async (value) => {
        server.enabled = value;
        await save();
      }));
    if (removable) {
      setting.addExtraButton((button) => button.setIcon("trash").setTooltip("Remove").onClick(() => void this.removeMcpServer(server.id)));
    }
    status();
  }

  private renderAddMcpServer(setting: Setting): void {
    setting
      .setDesc(this.plugin.settings.mcpServers?.length ? "" : "No servers yet.")
      .addButton((button) => button.setButtonText("Add server").onClick(() => void this.addMcpServer()));
  }

  private async addMcpServer(): Promise<void> {
    const s = this.plugin.settings;
    // getRandomValues also works in mobile WebViews without secure-context
    // APIs such as randomUUID/SubtleCrypto.
    const id = `mcp-${Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, "0")).join("")}`;
    s.mcpServers = [...s.mcpServers ?? [], { id, name: "", url: "", enabled: false }];
    await this.plugin.saveSettings();
    this.refreshSettingsTab();
  }

  private async removeMcpServer(id: string): Promise<void> {
    await this.plugin.removeMcpServer(id);
    this.refreshSettingsTab();
  }

  private renderDebugLog(setting: Setting): void {
    const s = this.plugin.settings;
    setting
      .setName(this.t("Debug log"))
      .setDesc(this.t("For troubleshooting: writes requests, errors and voice events to debug.log in the plugin folder, including your messages (never keys). Copy it to send it on."))
      .addToggle((toggle) =>
        toggle
          .setValue(s.debugLog)
          .onChange(async (value) => {
            s.debugLog = value;
            await this.plugin.saveSettings();
          })
      )
      .addButton((button) => button.setButtonText(this.t("Copy")).onClick(() => void this.plugin.copyDebugLog()))
      .addButton((button) => button.setButtonText(this.t("Clear")).onClick(async () => {
        await clearDebugLog(this.app);
        new Notice(this.t("Debug log cleared."));
      }));
  }

  // ─── API key + test (anthropic / openai) ──────────────────────────────────

  private renderApiKeySection(containerEl: HTMLElement, row?: Setting): void {
    const s = this.plugin.settings;

    const apiKeySetting = (row ?? new Setting(containerEl))
      .setName("API key")
      .setDesc(s.apiKey ? "Key saved" : "Enter your API key to get started")
      .addText((text) => {
        text.inputEl.type = "password";
        text
          .setPlaceholder("Enter your API key")
          .setValue(s.apiKey)
          .onChange(async (value) => {
            this.apiKeyEditing = true;
            window.clearTimeout(this.apiKeyTimer);
            const hadKey = s.apiKey;
            s.apiKey = value.trim();
            const editedKey = s.apiKey;
            await this.plugin.saveSettings();
            if (s.apiKey !== editedKey) return;
            if (hadKey !== s.apiKey) {
              clearCatalogModels(s.provider);
              this.catalogModels = undefined;
              this.catalogIdentity = "";
            }
            this.apiKeyTimer = window.setTimeout(() => {
              this.apiKeyEditing = false;
              this.refreshSettingsTab();
            }, 800);
          });
      });

    if (s.apiKey) {
      apiKeySetting.addButton((button) =>
        button.setButtonText("Test").onClick(async () => {
          button.setButtonText("Testing...");
          button.setDisabled(true);
          try {
            const { sendMessage } = await import("./api/client");
            const response = await sendMessage(
              connectionTestSettings(s),
              [{ role: "user", content: "Say hello in one word." }],
              [],
              "You are a test. Respond with one word."
            );
            const text = response.content
              .filter((b) => b.type === "text")
              .map((b) => b.text)
              .join("");
            new Notice(`Connected! Response: "${text}"`);
            apiKeySetting.setDesc("Connection successful");
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            new Notice(`Connection failed: ${msg}`);
            apiKeySetting.setDesc(`Failed: ${msg}`);
          } finally {
            button.setButtonText("Test");
            button.setDisabled(false);
          }
        })
      );
    }
  }

  // ─── ChatGPT OAuth ────────────────────────────────────────────────────────

  private renderChatGPTOAuthSection(containerEl: HTMLElement, row?: Setting): void {
    const credential = this.plugin.chatgptOAuth.getCredential();

    const explainer = containerEl.createDiv({
      cls: "setting-item-description ochatting-oauth-explainer",
    });
    if (row) row.settingEl.before(explainer);
    explainer.createSpan({
      text: this.t("Sign in with your ChatGPT account instead of using an OpenAI API key. Requests are routed through the ChatGPT/Codex backend (not "),
    });
    explainer.createEl("code", { text: "api.openai.com" });
    explainer.createSpan({
      text: this.t(") and require an active ChatGPT plan with Codex access. Refresh the model list to see the catalog for your account. Listed models may still depend on account permissions."),
    });

    if (credential) {
      const account = credential.accountId
        ? maskAccountId(credential.accountId)
        : this.t("without an ID");
      const expires = new Date(credential.expiresAt).toLocaleString();
      (row ?? new Setting(containerEl))
        .setName(this.t("ChatGPT account"))
        .setDesc(this.t("Connected — account {account}. Token expires {expires}.", { account, expires }))
        .addButton((button) => {
          button
            .setButtonText(this.t("Disconnect"))
            .onClick(async () => {
              this.plugin.chatgptOAuth.clearCredential();
              clearCatalogModels("chatgpt-oauth");
              this.catalogModels = undefined;
              this.catalogIdentity = "";
              if (this.plugin.settings.modelCatalog) {
                this.plugin.settings.modelCatalog.entries = this.plugin.settings.modelCatalog.entries.filter(e => e.provider !== "chatgpt-oauth");
                await this.plugin.saveSettings();
              }
              this.plugin.updateVoiceAvailable();
              new Notice(this.t("ChatGPT OAuth disconnected."));
              this.refreshSettingsTab();
            });
          if (requireApiVersion("1.13.0")) button.setDestructive();
          else button.setWarning();
        })
        .addButton((button) =>
          button.setButtonText(this.t("Test")).onClick(async () => {
            button.setButtonText(this.t("Testing..."));
            button.setDisabled(true);
            try {
              const { sendMessage } = await import("./api/client");
              const response = await sendMessage(
                connectionTestSettings(this.plugin.settings),
                [{ role: "user", content: "Say hello in one word." }],
                [],
                "You are a test. Respond with one word."
              );
              const text = response.content
                .filter((b) => b.type === "text")
                .map((b) => b.text)
                .join("");
              new Notice(this.t("Connected! Response: \"{text}\"", { text: text || this.t("no text") }));
            } catch (e) {
              const msg = e instanceof Error ? e.message : String(e);
              new Notice(this.t("Connection test failed: {error}", { error: msg }));
            } finally {
              button.setButtonText(this.t("Test"));
              button.setDisabled(false);
            }
          })
        );
    } else {
      const loginRow = (row ?? new Setting(containerEl))
        .setName(this.t("ChatGPT account"))
        .setDesc(Platform.isDesktop
          ? this.t("Sign in in your browser. A device code is also available if browser login cannot connect.")
          : this.t("Sign in with a one-time device code, then return to Obsidian to finish connecting."))
        .addButton((button) =>
          button
            .setButtonText(this.t(Platform.isDesktop ? "Sign in with ChatGPT" : "Connect ChatGPT"))
            .setCta()
            .onClick(async () => {
              button.setDisabled(true);
              try {
                await this.connectChatGPT();
              } finally {
                button.setDisabled(false);
              }
            })
        );
      if (Platform.isDesktop) loginRow.addButton((button) =>
        button.setButtonText(this.t("Use device code")).onClick(async () => {
          button.setDisabled(true);
          try { await this.startDeviceLogin(); }
          finally { button.setDisabled(false); }
        })
      );
    }
  }

  private async startDeviceLogin(): Promise<void> {
    try {
      this.plugin.chatgptOAuth.cancelBrowserLogin();
      const auth = await this.plugin.chatgptOAuth.beginDeviceAuthorization();
      const handle = this.plugin.chatgptOAuth.pollDeviceAuthorization(auth);
      new ChatGPTDeviceLoginModal(this.app, auth, handle, () => this.signedIn(), this.language).open();
    } catch (e) {
      new Notice(e instanceof Error ? e.message : this.t("Failed to start ChatGPT login."));
    }
  }

  /**
   * Sign in with ChatGPT: in the browser on desktop, with a device code on
   * mobile. The provider's row and the voice row use it.
   */
  private async connectChatGPT(): Promise<void> {
    if (!Platform.isDesktop) {
      await this.startDeviceLogin();
      return;
    }
    try {
      const login = await this.plugin.chatgptOAuth.beginBrowserAuthorization();
      new ChatGPTBrowserLoginModal(this.app, login, () => this.signedIn(), this.language).open();
      window.open(login.authUrl, "_blank");
    } catch (e) {
      new Notice(e instanceof Error ? e.message : this.t("Failed to start ChatGPT login."));
    }
  }

  /** After a sign-in: the chat's voice button follows it, and the settings show it. */
  private signedIn(): void {
    this.plugin.updateVoiceAvailable();
    this.refreshSettingsTab();
  }

  // ─── Model picker ─────────────────────────────────────────────────────────

  private modelPreferenceItems(): SettingDefinition[] {
    const models = this.catalogModels ?? getCatalogModels("chatgpt-oauth") ?? [];
    return models.map((model) => ({
      name: model.label,
      aliases: [model.value],
      render: (setting: Setting) => this.renderModelPreference(setting, model),
    }));
  }

  private renderModels(containerEl: HTMLElement): void {
    this.renderModelCatalogStatus(new Setting(containerEl));
    const models = this.catalogModels ?? getCatalogModels("chatgpt-oauth") ?? [];
    for (const model of models) this.renderModelPreference(new Setting(containerEl), model);
  }

  private renderModelCatalogStatus(setting: Setting): void {
    const credential = this.plugin.chatgptOAuth?.getCredential?.();
    const models = this.catalogModels ?? getCatalogModels("chatgpt-oauth") ?? [];
    const status = !credential
      ? this.t("Connect ChatGPT to load the models available to this account.")
      : models.length
        ? this.t("{count} models from the ChatGPT account. The list is cached for 24 hours.", { count: models.length })
        : this.t("No model catalog loaded yet. Refresh to ask ChatGPT for this account's models.");
    setting
      .setName(this.t("Model catalog"))
      .setDesc(this.catalogError ? `${status} ${this.catalogError}` : status)
      .addButton((button) => button
        .setIcon("refresh-cw")
        .setTooltip(this.t("Refresh models now"))
        .setDisabled(!credential || this.loadingCatalog)
        .onClick(() => void this.loadCatalog(true)));
  }

  private renderModelPreference(setting: Setting, model: ModelOption): void {
    const s = this.plugin.settings;
    s.modelPreferences ??= {};
    const preference: ModelPreference = { ...(s.modelPreferences[model.value] ?? {}) };
    const enabled = preference.enabled !== false;
    const apiWindow = model.contextWindow;
    const override = validContextWindow(preference.contextWindow);
    const effective = override ?? apiWindow;
    const current = s.model === model.value;
    setting
      .setName(model.label)
      .setDesc([
        model.value,
        current ? this.t("Current model") : "",
        effective ? this.t("Context: {window}", { window: formatTokens(effective) }) : this.t("Context window unknown"),
        override ? this.t("Custom context window") : "",
      ].filter(Boolean).join(" · "))
      .addToggle((toggle) => toggle
        .setValue(enabled)
        .setTooltip(current ? this.t("Switch to another model before disabling this one") : this.t("Show this model in the chat picker"))
        .setDisabled(current)
        .onChange(async (value) => {
          s.modelPreferences ??= {};
          if (value) {
            const next = { ...(s.modelPreferences[model.value] ?? {}) };
            delete next.enabled;
            if (Object.keys(next).length) s.modelPreferences[model.value] = next;
            else delete s.modelPreferences[model.value];
          } else {
            s.modelPreferences[model.value] = { ...(s.modelPreferences[model.value] ?? {}), enabled: false };
          }
          await this.plugin.saveSettings();
          this.refreshSettingsTab();
        }))
      .addText((text) => {
        text.inputEl.addClass("stark-model-context-input");
        text.inputEl.inputMode = "decimal";
        text.setPlaceholder(apiWindow ? formatTokens(apiWindow) : "128K / 1M");
        text.setValue(override ? formatTokens(override) : "");
        const commit = async () => {
          const raw = text.getValue().trim();
          if (!raw) {
            this.clearModelContextOverride(model.value);
            await this.plugin.saveSettings();
            this.refreshSettingsTab();
            return;
          }
          const tokens = parseTokens(raw);
          if (tokens === null || tokens < 1000) {
            new Notice(this.t("Enter a context window of at least 1K (for example 128K or 1M)."));
            text.setValue(override ? formatTokens(override) : "");
            return;
          }
          if (apiWindow && tokens === apiWindow) this.clearModelContextOverride(model.value);
          else {
            s.modelPreferences ??= {};
            s.modelPreferences[model.value] = { ...(s.modelPreferences[model.value] ?? {}), contextWindow: tokens };
          }
          await this.plugin.saveSettings();
          this.refreshSettingsTab();
        };
        text.inputEl.addEventListener("change", () => void commit());
        text.inputEl.addEventListener("keydown", (event) => {
          if (event.key === "Enter" && !event.isComposing) {
            event.preventDefault();
            void commit();
          }
        });
      })
      .addExtraButton((button) => button
        .setIcon("rotate-ccw")
        .setTooltip(this.t("Restore the API context window"))
        .setDisabled(!override)
        .onClick(async () => {
          this.clearModelContextOverride(model.value);
          await this.plugin.saveSettings();
          this.refreshSettingsTab();
        }));
  }

  private clearModelContextOverride(model: string): void {
    const s = this.plugin.settings;
    const preference = s.modelPreferences?.[model];
    if (!preference) return;
    const next = { ...preference };
    delete next.contextWindow;
    s.modelPreferences ??= {};
    if (Object.keys(next).length) s.modelPreferences[model] = next;
    else delete s.modelPreferences[model];
  }

  private credentialIdentity(): string {
    const s = this.plugin.settings;
    if (s.provider !== "chatgpt-oauth") return s.apiKey;
    const credential = this.plugin.chatgptOAuth.getCredential();
    return credential ? credential.accountId || credential.accessToken : "";
  }

  private async loadCatalog(force: boolean): Promise<void> {
    if (this.loadingCatalog || this.apiKeyEditing) return;
    const s = this.plugin.settings;
    const provider = s.provider;
    const secretIdentity = this.credentialIdentity();
    if (!secretIdentity) return;
    this.loadingCatalog = true;
    const current = () => s.provider === provider && this.credentialIdentity() === secretIdentity;
    let changed = false;
    try {
      const identity = await catalogIdentity(provider, secretIdentity);
      if (!current()) return;
      const state: CatalogState = s.modelCatalog ??= { entries: [] };
      const cached = cachedCatalog(state, provider, identity);
      if (cached) this.plugin.refreshModelHeader();
      if (this.catalogIdentity !== identity) {
        this.catalogIdentity = identity;
        this.catalogModels = cached?.models;
        this.catalogError = "";
        changed = true;
      }
      if (changed && cached) this.refreshSettingsTab();
      if (!force && cached && Date.now() - cached.fetchedAt >= 0 && Date.now() - cached.fetchedAt < CATALOG_TTL) return;
      const models = await refreshCatalog(state, provider, identity, s.apiKey, this.plugin.chatgptOAuth, force);
      if (!current()) return;
      if (models.length && this.catalogModels !== models) {
        this.catalogModels = models;
        changed = true;
        const available = getAvailableModelOptions(provider, s);
        if (!available.some((model) => model.value === s.model)) {
          const first = available[0];
          if (first) {
            s.model = first.value;
            s.thinkingLevel = "";
          }
        }
        await this.plugin.saveSettings();
      }
      this.catalogError = "";
      if (force) new Notice(this.t("Loaded {count} models", { count: models.length }));
    } catch (error) {
      if (current()) {
        this.catalogError = this.t("Could not refresh models. Keeping the last list; use refresh to retry.");
        changed = true;
        if (force) new Notice(this.t("Failed to load models: {error}", {
          error: error instanceof Error ? error.message : String(error),
        }));
      }
    } finally {
      this.loadingCatalog = false;
      if (current() && (changed || force)) this.refreshSettingsTab();
      else if (!current()) this.refreshSettingsTab();
    }
  }

}

// ─── Device-flow login modal ────────────────────────────────────────────────

export class ChatGPTDeviceLoginModal extends Modal {
  private cancelled = false;

  constructor(
    app: App,
    private readonly authorization: ChatGPTDeviceAuthorization,
    private readonly handle: PollHandle,
    private readonly onComplete: () => void,
    private readonly language: Language = "en",
  ) {
    super(app);
  }

  private t(source: string, variables?: Record<string, string | number>): string {
    return translate(this.language, source, variables);
  }

  /** Suppress backdrop events only; Escape, Cancel and successful login still close normally. */
  private ignoreBackgroundClicks(): void {
    const background = this.containerEl.querySelector(".modal-bg");
    const ignore = (event: Event) => {
      event.preventDefault();
      event.stopImmediatePropagation();
    };
    for (const type of ["pointerdown", "mousedown", "click", "touchstart"]) {
      background?.addEventListener(type, ignore, { capture: true, passive: false });
    }
  }

  onOpen(): void {
    this.ignoreBackgroundClicks();
    const { contentEl } = this;
    contentEl.empty();
    new Setting(contentEl).setName(this.t("Connect ChatGPT")).setHeading();

    contentEl.createEl("p", {
      text: this.t("Open the login page, sign in, and paste the one-time code below:"),
    });
    const linkRow = contentEl.createDiv({ cls: "ochatting-device-link-row" });
    const link = linkRow.createEl("a", {
      text: this.authorization.verificationUri,
      href: this.authorization.verificationUri,
    });
    link.setAttr("target", "_blank");
    link.setAttr("rel", "noopener");

    contentEl.createEl("p", { text: this.t("Your code (expires after 15 minutes):") });
    const codeRow = contentEl.createDiv({ cls: "ochatting-device-code-row" });

    codeRow.createEl("code", {
      text: this.authorization.userCode,
      cls: "ochatting-device-code",
    });

    const copyBtn = codeRow.createEl("button", { text: this.t("Copy code") });
    copyBtn.addEventListener("click", () => {
      navigator.clipboard
        .writeText(this.authorization.userCode)
        .then(() => new Notice(this.t("Code copied.")))
        .catch(() => new Notice(this.t("Failed to copy code.")));
    });

    const status = contentEl.createEl("p", {
      text: this.t("Waiting for authorization. Return to Obsidian after approving the login; connecting will finish automatically."),
      cls: "ochatting-device-status",
    });

    contentEl.createEl("p", { text: this.t("If device-code login is unavailable, enable it in your ChatGPT security settings or ask your workspace admin.") });

    const buttons = contentEl.createDiv({ cls: "ochatting-device-buttons" });

    const openBtn = buttons.createEl("button", { text: this.t("Copy code and open login page") });
    openBtn.classList.add("mod-cta");
    openBtn.addEventListener("click", () => {
      // Open during the gesture: awaiting clipboard first can block the new browser tab.
      const copied = (async () => { await navigator.clipboard.writeText(this.authorization.userCode); })();
      window.open(this.authorization.verificationUri, "_blank");
      void copied.then(() => {
        status.setText(this.t("Code copied. Paste it on the login page, approve, then return to Obsidian."));
      }).catch(() => {
        status.setText(this.t("Could not copy the code. Enter the code shown above on the login page, then return here."));
        new Notice(this.t("Could not copy the code. Enter it manually on the login page."));
      });
    });

    const cancelBtn = buttons.createEl("button", { text: this.t("Cancel") });
    cancelBtn.addEventListener("click", () => {
      this.cancelled = true;
      this.handle.cancel();
      this.close();
    });

    // Wait for the poll to finish.
    this.handle.promise
      .then(() => {
        if (this.cancelled) return;
        new Notice(this.t("ChatGPT connected."));
        this.onComplete();
        this.close();
      })
      .catch((e: unknown) => {
        if (this.cancelled) return;
        const msg = e instanceof Error ? e.message : String(e);
        status.setText(this.t("Login failed: {error}", { error: msg }));
        status.removeClass("ochatting-device-status");
        status.addClass("ochatting-device-status-error");
      });
  }

  onClose(): void {
    if (!this.cancelled) {
      // If the user closed via Esc or the close button, treat it as cancel.
      this.handle.cancel();
    }
    this.contentEl.empty();
  }
}

/** Desktop browser callback UI. Closing it always releases the local listener. */
export class ChatGPTBrowserLoginModal extends Modal {
  private cancelled = false;
  constructor(app: App, private readonly login: BrowserLogin, private readonly onComplete: () => void, private readonly language: Language = "en") {
    super(app);
  }
  private t(source: string): string {
    return translate(this.language, source);
  }
  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    new Setting(contentEl).setName(this.t("Sign in with ChatGPT")).setHeading();
    const status = contentEl.createEl("p", { text: this.t("Finish signing in in your browser. This window will close when ChatGPT is connected.") });
    const reopen = contentEl.createEl("button", { text: this.t("Open login page again") });
    reopen.addEventListener("click", () => window.open(this.login.authUrl, "_blank"));
    const cancel = contentEl.createEl("button", { text: this.t("Cancel") });
    cancel.addEventListener("click", () => this.close());
    void this.login.promise.then(() => {
      if (this.cancelled) return;
      new Notice(this.t("ChatGPT connected."));
      this.onComplete();
      this.close();
    }).catch((error: unknown) => {
      if (this.cancelled) return;
      status.setText(error instanceof Error ? error.message : this.t("Login failed. Try again or use a device code."));
      reopen.disabled = true;
      cancel.setText(this.t("Close"));
    });
  }
  onClose(): void {
    this.cancelled = true;
    this.login.cancel();
    this.contentEl.empty();
  }
}

function maskAccountId(accountId: string): string {
  if (accountId.length <= 8) return accountId;
  return `${accountId.slice(0, 4)}…${accountId.slice(-4)}`;
}
