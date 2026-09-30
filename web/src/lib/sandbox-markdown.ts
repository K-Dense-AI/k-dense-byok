import { API_BASE } from "@/lib/projects";
import { withApiToken } from "@/lib/api-auth";

/** Only relative, sandbox-contained file references are rewritten. */
export function sandboxMarkdownPath(value: unknown): string | undefined {
  if (typeof value !== "string" || !value || /^[#/?]|^[a-z][a-z\d+.-]*:/i.test(value)) return;
  let decoded: string;
  try {
    decoded = decodeURIComponent(value.split(/[?#]/, 1)[0]);
  } catch {
    return;
  }
  if (!decoded || /[\\\x00-\x1f:]/.test(decoded) || decoded.startsWith("/")) return;
  const parts = decoded.split("/").filter((part) => part !== "." && part !== "");
  if (!parts.length || parts.some((part) => part === "..")) return;
  return parts.join("/");
}

interface MarkdownNode {
  tagName?: string;
  properties?: Record<string, unknown>;
  children?: MarkdownNode[];
}

/** Run after HTML sanitization and before Streamdown blocks relative URLs. */
export function sandboxMarkdownUrls(projectId: string) {
  return () => (tree: MarkdownNode) => {
    const visit = (node: MarkdownNode) => {
      const key = node.tagName === "a" ? "href" : node.tagName === "img" ? "src" : null;
      if (key && node.properties) {
        // Only this pass may mark a link as an in-app file action.
        delete node.properties["data-kady-file"];
        delete node.properties.dataKadyFile;
        const original = node.properties[key];
        const path = sandboxMarkdownPath(original);
        if (path) {
          node.properties[key] = withApiToken(
            `${API_BASE}/sandbox/raw?path=${encodeURIComponent(path)}&project=${encodeURIComponent(projectId)}`,
          );
          if (key === "href") node.properties["data-kady-file"] = path;
        } else if (typeof original === "string" && original && !/^[#/?]|^[a-z][a-z\d+.-]*:/i.test(original)) {
          // Do not let malformed/traversing relative paths become app URLs.
          delete node.properties[key];
        }
      }
      node.children?.forEach(visit);
    };
    visit(tree);
  };
}
