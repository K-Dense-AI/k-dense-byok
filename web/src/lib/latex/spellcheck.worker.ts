/**
 * Spell check worker: owns the typo-js dictionary (parsing the .dic blocks
 * the main thread for ~1s, so it lives here). Protocol: {id, type, ...} in,
 * {id, ...} out. Unknown-word results and suggestions are memoized.
 */
import Typo from "typo-js";

// Worker global — the default TS lib types `self` as Window, whose
// postMessage signature differs; alias the two members we use.
const ctx = self as unknown as {
  postMessage: (msg: unknown) => void;
  addEventListener: (type: "message", cb: (e: MessageEvent) => void) => void;
};

let dict: Typo | null = null;
const checkCache = new Map<string, boolean>();
const suggestCache = new Map<string, string[]>();

const ready = (async () => {
  try {
    const [affRes, dicRes] = await Promise.all([
      fetch("/dict/en_US.aff"),
      fetch("/dict/en_US.dic"),
    ]);
    if (!affRes.ok || !dicRes.ok) {
      throw new Error(
        `dictionary fetch failed: aff=${affRes.status} dic=${dicRes.status}`,
      );
    }
    const [aff, dic] = await Promise.all([affRes.text(), dicRes.text()]);
    dict = new Typo("en_US", aff, dic, { platform: "any" });
  } catch (err) {
    // Never let ready() reject — the message handler awaits it on every
    // request, and an unhandled rejection would throw before postMessage,
    // permanently hanging the client's promise for that id.
    console.warn("spellcheck: dictionary failed to load", err);
    dict = null;
  }
})();

function checkWord(word: string): boolean {
  if (!dict) return true; // not ready — treat everything as correct
  let ok = checkCache.get(word);
  if (ok === undefined) {
    ok = dict.check(word) || dict.check(word.toLowerCase());
    checkCache.set(word, ok);
  }
  return ok;
}

ctx.addEventListener("message", async (e: MessageEvent) => {
  const msg = e.data as
    | { id: number; type: "check"; words: string[] }
    | { id: number; type: "suggest"; word: string };
  try {
    await ready;
    if (msg.type === "check") {
      const misspelled = [...new Set(msg.words)].filter((w) => !checkWord(w));
      ctx.postMessage({ id: msg.id, misspelled });
    } else {
      let suggestions = suggestCache.get(msg.word);
      if (!suggestions) {
        suggestions = dict ? dict.suggest(msg.word, 5) : [];
        suggestCache.set(msg.word, suggestions);
      }
      ctx.postMessage({ id: msg.id, suggestions });
    }
  } catch (err) {
    // Guarantee exactly one reply per request id no matter what fails —
    // otherwise the client's pending promise for this id hangs forever.
    console.warn("spellcheck: request failed", err);
    if (msg.type === "check") {
      ctx.postMessage({ id: msg.id, misspelled: [] });
    } else {
      ctx.postMessage({ id: msg.id, suggestions: [] });
    }
  }
});
