import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import Fastify from "fastify";
import AdmZip from "adm-zip";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { registerOfficeRoutes } from "../src/api/office.ts";
import { ensureProjectExists, resolvePaths } from "../src/projects.ts";
import { PROJECTS_ROOT } from "../src/config.ts";
import { withActiveProject } from "../src/scope.ts";

const fixtures = path.join(__dirname, "fixtures/office");
const app = Fastify();
app.addContentTypeParser("application/octet-stream", { parseAs: "buffer" }, (_req, body, done) => done(null, body));
app.addHook("onRequest", (req, _reply, done) => withActiveProject(String(req.headers["x-project-id"] ?? "default"), done));
await registerOfficeRoutes(app);
const root = () => resolvePaths("default").sandbox;
const file = (name: string) => path.join(root(), name);
const get = (name: string, binary = false, query = "", project = "default") => app.inject({ method: "GET", url: `/sandbox/office${binary ? "/content" : ""}?path=${encodeURIComponent(name)}${query}`, headers: { "x-project-id": project } });
const put = (name: string, revision: string, payload: Buffer) => app.inject({ method: "PUT", url: `/sandbox/office/content?path=${encodeURIComponent(name)}`, headers: { "content-type": "application/octet-stream", "if-match": revision }, payload });
const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const modified = (name: string) => {
  const zip = new AdmZip(file(name));
  const part = name.endsWith("docx") ? "word/document.xml" : name.endsWith("pptx") ? "ppt/slides/slide1.xml" : "xl/worksheets/sheet1.xml";
  zip.updateFile(part, Buffer.from(zip.readAsText(part).replace(name.endsWith("xlsx") ? "Control" : "Research overview", "Edited in Office")));
  return zip.toBuffer();
};
beforeAll(() => ensureProjectExists("default"));
beforeEach(() => { for (const name of ["report.docx", "slides.pptx", "workbook.xlsx"]) fs.copyFileSync(path.join(fixtures, name), file(name)); });
afterAll(async () => { await app.close(); fs.rmSync(PROJECTS_ROOT, { recursive: true, force: true }); });

describe("Office preview and binary editor saves", () => {
  it.each(["report.docx", "slides.pptx", "workbook.xlsx"])("loads and atomically replaces %s with provenance", async name => {
    const response = await get(name, true);
    expect(response.statusCode, response.body).toBe(200);
    expect(response.rawPayload).toEqual(fs.readFileSync(file(name)));
    expect(response.headers["x-office-read-only"]).toBe("false");
    expect(response.headers["cache-control"]).toBe("no-store");
    const bytes = modified(name);
    const saved = await put(name, String(response.headers["x-content-sha256"]), bytes);
    expect(saved.statusCode, saved.body).toBe(200);
    expect(saved.json().revision).toBe(hash(bytes));
    expect(fs.readFileSync(file(name))).toEqual(bytes);
    expect(fs.readdirSync(root()).some(n => n.startsWith(".office-"))).toBe(false);
    const provenance = fs.readFileSync(path.join(root(), ".kady/provenance/user-actions/steps.jsonl"), "utf8");
    expect(provenance).toContain('"role":"user"'); expect(provenance).toContain(name);
  });
  it("retains styled preview content, worksheet formulas, literal values, and sheet windows", async () => {
    const doc = (await get("report.docx")).json();
    expect(doc.data).toBe(fs.readFileSync(file("report.docx")).toString("base64"));
    expect(doc.groups[0].paragraphs.flatMap((p: any) => p.runs)).toContainEqual(expect.objectContaining({ text: "Baseline ", bold: true }));
    const sheet = (await get("workbook.xlsx")).json();
    expect(sheet.cells).toContainEqual(expect.objectContaining({ ref: "C2", type: "formula", value: "=B2*2" }));
    expect(sheet.cells).toContainEqual(expect.objectContaining({ ref: "D2", type: "text", value: "=not a formula" }));
    expect((await get("workbook.xlsx", false, "&row=51")).json().cells).toContainEqual(expect.objectContaining({ ref: "A51", value: "Later page" }));
  });
  it("refuses concurrent and stale saves without overwriting the winner", async () => {
    const revision = hash(fs.readFileSync(file("report.docx"))), bytes = modified("report.docx");
    const responses = await Promise.all([put("report.docx", revision, bytes), put("report.docx", revision, bytes)]);
    expect(responses.map(r => r.statusCode).sort()).toEqual([200, 409]);
    expect((await put("report.docx", revision, bytes)).statusCode).toBe(409);
    expect(fs.readFileSync(file("report.docx"))).toEqual(bytes);
  });
  it("rejects malformed saves and wrong file types without changing the original", async () => {
    const original = fs.readFileSync(file("report.docx"));
    for (const bytes of [Buffer.from("not a zip"), fs.readFileSync(file("workbook.xlsx"))]) {
      expect((await put("report.docx", hash(original), bytes)).statusCode).toBe(422);
      expect(fs.readFileSync(file("report.docx"))).toEqual(original);
    }
    expect((await put("report.docx", "invalid", original)).statusCode).toBe(400);
  });
  it("rejects traversal, missing files, invalid windows, oversized and ambiguous archives", async () => {
    expect((await get("../report.docx", true)).statusCode).toBe(403);
    expect((await get("missing.docx", true)).statusCode).toBe(404);
    expect((await get("workbook.xlsx", false, "&row=-1")).statusCode).toBe(400);
    const archive = new AdmZip(); archive.addFile("word/document.xml", Buffer.alloc(65 * 1024 * 1024, 65)); archive.writeZip(file("bomb.docx"));
    const bomb = await get("bomb.docx", true); expect(bomb.statusCode).toBe(422); expect(bomb.json().detail).toContain("64 MiB");
  });
  it("rejects XML entities and preserves signed documents", async () => {
    const archive = new AdmZip(file("report.docx"));
    archive.updateFile("word/document.xml", Buffer.from('<!DOCTYPE x [<!ENTITY x SYSTEM "file:///etc/passwd">]><x>&x;</x>')); archive.writeZip(file("entity.docx"));
    expect((await get("entity.docx", true)).statusCode).toBe(422);
    const signed = new AdmZip(file("report.docx")); signed.addFile("_xmlsignatures/sig1.xml", Buffer.from("<signature/>")); signed.writeZip(file("signed.docx"));
    const response = await get("signed.docx", true); expect(response.statusCode).toBe(200); expect(response.headers["x-office-read-only"]).toBe("true");
    expect((await put("signed.docx", String(response.headers["x-content-sha256"]), modified("report.docx"))).statusCode).toBe(403);
  });
  it("scopes document reads by project and prevents symlink escape", async () => {
    const other = ensureProjectExists("office-other"); fs.copyFileSync(file("slides.pptx"), path.join(other.sandbox, "only-here.pptx"));
    expect((await get("only-here.pptx", true)).statusCode).toBe(404);
    expect((await get("only-here.pptx", true, "", "office-other")).statusCode).toBe(200);
    fs.symlinkSync(path.join(other.sandbox, "only-here.pptx"), file("escape.pptx"));
    expect((await get("escape.pptx", true)).statusCode).toBe(403);
  });
});
