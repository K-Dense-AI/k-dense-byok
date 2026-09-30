import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { officeHtmlDocument, renderOffice } from "./office-render";
describe("Office render isolation", () => {
  it("strips active markup and navigation, isolates styles, and prohibits network loads", () => {
    const html = officeHtmlDocument('<style>body{color:red;background:url(https://example.test/beacon)}</style><script>alert(1)</script><img src="data:image/png;base64,AA" onerror="alert(2)"><a href="https://example.test/">text</a><iframe src="https://example.test/"></iframe>');
    expect(html).toContain("Content-Security-Policy"); expect(html).toContain("default-src 'none'"); expect(html).toContain("color:red"); expect(html).not.toMatch(/<script|onerror|href=|<iframe/);
  });
  it("renders a real deck with images, styled text and tables to passive SVG images", async () => {
    const data = readFileSync(resolve(process.cwd(), "../server/test/fixtures/office/slides.pptx")).toString("base64");
    const result = await renderOffice({ kind: "pptx", revision: "test", data, groups: [], readOnly: false }); expect(result.slides).toHaveLength(2);
    const svg = decodeURIComponent(result.slides![0].split(",").slice(1).join(",")); expect(svg).toContain("Research overview"); expect(svg).toContain("<image"); expect(svg).not.toContain("foreignObject");
  });
});
