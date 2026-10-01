import { afterEach, describe, expect, it, vi } from "vitest";
import { runtimeApiBase } from "./runtime-config";

afterEach(() => vi.unstubAllEnvs());
describe("runtime API configuration", () => {
  it("uses a launcher-selected port without rebuilding the web app", () => {
    expect(runtimeApiBase({ apiBase: "http://localhost:49123/" })).toBe("http://localhost:49123");
  });
  it("preserves source and remote install configuration", () => {
    vi.stubEnv("NEXT_PUBLIC_ADK_API_URL", "https://research.example/api");
    expect(runtimeApiBase()).toBe("https://research.example/api");
  });
  it.each(["javascript:alert(1)", "https://secret:password@example.com", "broken"])("rejects unsafe runtime addresses: %s", (apiBase) => {
    vi.stubEnv("NEXT_PUBLIC_ADK_API_URL", "http://localhost:8000");
    expect(runtimeApiBase({ apiBase })).toBe("http://localhost:8000");
  });
});
