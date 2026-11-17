import { App, Modal, Setting } from "obsidian";
import { translate, type Language } from "../i18n";
import { toolCatalogItem } from "../agent/tool-policy";

const MAX_PREVIEW = 4000;

function inputPreview(input: Record<string, unknown>): string {
  let text = "";
  try {
    text = JSON.stringify(input, null, 2);
  } catch {
    text = String(input);
  }
  return text.length > MAX_PREVIEW ? `${text.slice(0, MAX_PREVIEW)}\n…` : text;
}

class ToolApprovalModal extends Modal {
  private settled = false;

  constructor(
    app: App,
    private readonly toolName: string,
    private readonly input: Record<string, unknown>,
    private readonly language: Language,
    private readonly resolve: (approved: boolean) => void,
  ) {
    super(app);
  }

  private t(source: string, variables?: Record<string, string | number>): string {
    return translate(this.language, source, variables);
  }

  private finish(approved: boolean): void {
    if (this.settled) return;
    this.settled = true;
    this.resolve(approved);
    this.close();
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("stark-tool-approval");
    const item = toolCatalogItem(this.toolName);
    new Setting(contentEl)
      .setName(this.t("Approve tool call?"))
      .setHeading();
    contentEl.createEl("p", {
      text: this.t("Stark wants to run {tool}. Review the parameters before allowing it.", {
        tool: this.t(item.label),
      }),
    });
    contentEl.createEl("p", {
      cls: "setting-item-description",
      text: this.t("This approval requirement comes from Agent settings. Change it there if you want this tool to run directly."),
    });
    const details = contentEl.createEl("details", { cls: "stark-tool-approval-input" });
    details.createEl("summary", { text: this.t("Parameters") });
    details.createEl("pre", { text: inputPreview(this.input) });

    const buttons = contentEl.createDiv({ cls: "modal-button-container" });
    const deny = buttons.createEl("button", { text: this.t("Reject") });
    deny.addEventListener("click", () => this.finish(false));
    const allow = buttons.createEl("button", { text: this.t("Allow once"), cls: "mod-cta" });
    allow.addEventListener("click", () => this.finish(true));
    window.setTimeout(() => allow.focus(), 0);
  }

  onClose(): void {
    if (!this.settled) {
      this.settled = true;
      this.resolve(false);
    }
    this.contentEl.empty();
  }
}

/** Ask before a tool with the user's "ask" permission runs. */
export function requestToolApproval(
  app: App,
  name: string,
  input: Record<string, unknown>,
  language: Language,
): Promise<boolean> {
  return new Promise((resolve) => {
    new ToolApprovalModal(app, name, input, language, resolve).open();
  });
}
