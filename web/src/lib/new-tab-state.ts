import type { ChatWorkspaceState } from "@/lib/workspace-persistence";

/**
 * The workspace state a freshly opened chat tab should start from.
 *
 * A new chat almost always continues the same piece of work the user was
 * already doing, so it inherits the *choices* the source tab was configured
 * with — model, thinking level, and compute target — but never that tab's
 * in-progress content. Draft text, attachments, pinned databases/skills, and
 * queued prompts belong to the conversation that created them, so they start
 * empty. With no source tab (the very first tab of a project) the caller
 * falls back to the app defaults instead.
 */
export function seedChatStateFromTab(
  source: ChatWorkspaceState | undefined,
): ChatWorkspaceState | null {
  if (!source) return null;
  return {
    selectedModel: source.selectedModel,
    thinkingLevel: source.thinkingLevel,
    selectedComputeTarget: source.selectedComputeTarget,
    attachedFiles: [],
    selectedDatabases: [],
    selectedSkills: [],
    queuedMessages: [],
    composer: { text: "", attachments: [] },
  };
}
