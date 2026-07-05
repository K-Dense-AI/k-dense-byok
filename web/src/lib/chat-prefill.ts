/**
 * Cross-panel "prefill the chat composer" handoff (e.g. the LaTeX editor's
 * Ask Kady button). A window event — like CHANGE_EVENT in projects.ts — so
 * distant components don't need prop threading. Two listeners cooperate:
 * the active chat tab's composer appends the text (chat-tab.tsx), and
 * page.tsx switches the right column back to the chat view so the prefilled
 * composer is actually visible.
 */

const PREFILL_EVENT = "kady:prefill-chat";

export function prefillChat(text: string): void {
  window.dispatchEvent(new CustomEvent(PREFILL_EVENT, { detail: { text } }));
}

export function onChatPrefill(handler: (text: string) => void): () => void {
  const listener = (e: Event) => {
    const text = (e as CustomEvent<{ text: string }>).detail?.text;
    if (text) handler(text);
  };
  window.addEventListener(PREFILL_EVENT, listener);
  return () => window.removeEventListener(PREFILL_EVENT, listener);
}
