/**
 * CodeMirror spell check extension for LaTeX prose. Reuses the lint
 * infrastructure: misspellings are "hint" diagnostics whose actions carry
 * suggestions and "Add to dictionary". The heavy lifting (dictionary,
 * suggestion search) happens in a Web Worker via SpellWorkerClient.
 */
import { linter, type Diagnostic } from "@codemirror/lint";
import type { Extension } from "@codemirror/state";
import { extractProseTokens, type ProseToken } from "./prose";

interface Pending {
  resolve: (value: never) => void;
}

export class SpellWorkerClient {
  private worker: Worker;
  private nextId = 1;
  private pending = new Map<number, (data: never) => void>();

  constructor(worker: Worker) {
    this.worker = worker;
    this.worker.addEventListener("message", (e: MessageEvent) => {
      const { id } = e.data as { id: number };
      const resolve = this.pending.get(id);
      if (resolve) {
        this.pending.delete(id);
        resolve(e.data as never);
      }
    });
  }

  private request<T>(payload: Record<string, unknown>): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolve) => {
      this.pending.set(id, resolve as Pending["resolve"]);
      this.worker.postMessage({ id, ...payload });
    });
  }

  async check(words: string[]): Promise<string[]> {
    const { misspelled } = await this.request<{ misspelled: string[] }>({
      type: "check",
      words,
    });
    return misspelled;
  }

  async suggest(word: string): Promise<string[]> {
    const { suggestions } = await this.request<{ suggestions: string[] }>({
      type: "suggest",
      word,
    });
    return suggestions;
  }

  dispose(): void {
    this.worker.terminate();
    for (const resolve of this.pending.values()) {
      (
        resolve as unknown as (v: {
          misspelled: string[];
          suggestions: string[];
        }) => void
      )({ misspelled: [], suggestions: [] });
    }
    this.pending.clear();
  }
}

export function createSpellWorker(): SpellWorkerClient | null {
  if (typeof Worker === "undefined") return null;
  try {
    return new SpellWorkerClient(
      new Worker(new URL("./spellcheck.worker.ts", import.meta.url), {
        type: "module",
      }),
    );
  } catch {
    return null; // spellcheck is an enhancement — never break the editor
  }
}

export function buildSpellDiagnostics(
  tokens: ProseToken[],
  misspelled: ReadonlySet<string>,
  ignored: ReadonlySet<string>,
  mkActions: (token: ProseToken) => Diagnostic["actions"],
): Diagnostic[] {
  const out: Diagnostic[] = [];
  for (const t of tokens) {
    if (!misspelled.has(t.word)) continue;
    if (ignored.has(t.word.toLowerCase())) continue;
    out.push({
      from: t.from,
      to: t.to,
      severity: "hint",
      source: "spellcheck",
      message: `Unknown word: ${t.word}`,
      actions: mkActions(t),
    });
  }
  return out;
}

const MAX_SUGGEST_PER_PASS = 10;

export function latexSpellLinter(opts: {
  client: () => SpellWorkerClient | null;
  ignored: () => ReadonlySet<string>;
  onAddWord: (word: string) => void;
}): Extension {
  return linter(
    async (view) => {
      const client = opts.client();
      if (!client) return [];
      const tokens = extractProseTokens(view.state.doc.toString());
      if (!tokens.length) return [];
      const unique = [...new Set(tokens.map((t) => t.word))];
      const misspelledList = await client.check(unique);
      const misspelled = new Set(misspelledList);

      // Fetch suggestions for a bounded number of distinct words per pass,
      // in parallel; the worker memoizes, so repeated passes fill the rest in.
      const suggestWords = misspelledList.slice(0, MAX_SUGGEST_PER_PASS);
      const suggestionPairs = await Promise.all(
        suggestWords.map(
          async (word) => [word, await client.suggest(word)] as const,
        ),
      );
      const suggestions = new Map<string, string[]>(suggestionPairs);

      return buildSpellDiagnostics(tokens, misspelled, opts.ignored(), (t) => {
        const fixes = (suggestions.get(t.word) ?? []).map((s) => ({
          name: s,
          apply: (v: typeof view, from: number, to: number) => {
            v.dispatch({ changes: { from, to, insert: s } });
          },
        }));
        return [
          ...fixes,
          {
            name: "Add to dictionary",
            apply: () => opts.onAddWord(t.word),
          },
        ];
      });
    },
    { delay: 500 },
  );
}
