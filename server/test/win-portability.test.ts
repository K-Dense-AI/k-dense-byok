/**
 * Windows-portability unit tests: the pure path-normalization and argument
 * building logic, exercised with Windows-shaped inputs (path.win32 injected /
 * backslash roots) so native-Windows behavior is verified from any host OS.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { apiRelative, toApiPath } from "../src/sandbox-fs.ts";
import { relativizeSandboxPaths, stripSandboxRoot } from "../src/agent/events.ts";
import { forwardArgs, inverseArgs } from "../src/latex/synctex.ts";

describe("toApiPath / apiRelative", () => {
  it("converts win32 separators to forward slashes", () => {
    expect(toApiPath("a\\b\\c.txt", "\\")).toBe("a/b/c.txt");
    expect(apiRelative("C:\\s", "C:\\s\\a\\b.txt", path.win32)).toBe("a/b.txt");
  });

  it("returns empty string for the root itself", () => {
    expect(apiRelative("C:\\s", "C:\\s", path.win32)).toBe("");
  });

  it("preserves .. escapes in wire format", () => {
    expect(apiRelative("C:\\s\\inner", "C:\\other", path.win32)).toBe("../../other");
  });

  it("is an identity on posix, even for filenames containing a backslash", () => {
    expect(toApiPath("a/weird\\name.txt", "/")).toBe("a/weird\\name.txt");
    expect(apiRelative("/s", "/s/a/weird\\name.txt", path.posix)).toBe("a/weird\\name.txt");
  });
});

describe("stripSandboxRoot", () => {
  const winRoot = "C:\\Users\\u\\projects\\p\\sandbox";

  it("strips a native win32 root and emits forward slashes", () => {
    expect(stripSandboxRoot(`${winRoot}\\sub\\a.py`, winRoot)).toBe("sub/a.py");
  });

  it("strips the forward-slash spelling of a win32 root", () => {
    expect(stripSandboxRoot("C:/Users/u/projects/p/sandbox/sub/a.py", winRoot)).toBe("sub/a.py");
  });

  it("maps the exact root to '.'", () => {
    expect(stripSandboxRoot(winRoot, winRoot)).toBe(".");
    expect(stripSandboxRoot("/s", "/s")).toBe(".");
  });

  it("matches a win32 root case-insensitively (NTFS)", () => {
    expect(stripSandboxRoot("c:\\users\\U\\PROJECTS\\p\\sandbox\\a.py", winRoot)).toBe("a.py");
    expect(stripSandboxRoot("c:/users/u/projects/p/sandbox/a.py", winRoot)).toBe("a.py");
    // ...but posix roots stay case-sensitive.
    expect(stripSandboxRoot("/S/a.py", "/s")).toBe("/S/a.py");
  });

  it("passes non-sandbox paths through unchanged", () => {
    expect(stripSandboxRoot("D:\\elsewhere\\a.py", winRoot)).toBe("D:\\elsewhere\\a.py");
    expect(stripSandboxRoot("relative/a.py", "/s")).toBe("relative/a.py");
  });

  it("keeps posix behavior identical to the old implementation", () => {
    expect(stripSandboxRoot("/s/a/b.txt", "/s")).toBe("a/b.txt");
    expect(stripSandboxRoot("/sandbox-adjacent/x", "/sandbox")).toBe("/sandbox-adjacent/x");
  });
});

describe("relativizeSandboxPaths with a win32 root", () => {
  const winRoot = "C:\\r\\sandbox";

  it("relativizes embedded occurrences inside command strings", () => {
    expect(relativizeSandboxPaths(`cd ${winRoot} && python ${winRoot}\\run.py`, winRoot)).toBe(
      "cd . && python run.py",
    );
  });

  it("normalizes separators in multi-segment embedded remainders", () => {
    expect(relativizeSandboxPaths(`python ${winRoot}\\out\\fig\\a.png`, winRoot)).toBe(
      "python out/fig/a.png",
    );
  });

  it("handles forward-slash and lowercase spellings the agent may emit", () => {
    expect(relativizeSandboxPaths("python C:/r/sandbox/run.py", winRoot)).toBe("python run.py");
    expect(relativizeSandboxPaths("python c:\\r\\sandbox\\run.py", winRoot)).toBe("python run.py");
  });

  it("recurses into objects and arrays", () => {
    expect(
      relativizeSandboxPaths({ path: `${winRoot}\\out\\fig.png`, other: 3 }, winRoot),
    ).toEqual({ path: "out/fig.png", other: 3 });
  });

  it("keeps posix behavior unchanged", () => {
    expect(relativizeSandboxPaths({ cmd: "cat /s/a.txt", p: "/s/a.txt" }, "/s")).toEqual({
      cmd: "cat a.txt",
      p: "a.txt",
    });
  });
});

describe("synctex argument builders", () => {
  it("keeps drive-letter colons out of forward-sync args", () => {
    const inv = forwardArgs("C:\\s\\doc\\main.tex", 12, 3, "C:\\s\\doc\\main.pdf", path.win32);
    expect(inv.cwd).toBe("C:\\s\\doc");
    expect(inv.inputs[0]).toBe("main.tex");
    expect(inv.args(inv.inputs[0])).toEqual(["view", "-i", "12:3:main.tex", "-o", "main.pdf"]);
  });

  it("offers an absolute forward-slash retry input", () => {
    const inv = forwardArgs("C:\\s\\src\\ch1.tex", 5, 0, "C:\\s\\build\\main.pdf", path.win32);
    expect(inv.inputs).toEqual(["../src/ch1.tex", "C:/s/src/ch1.tex"]);
  });

  it("tries relative first then absolute on posix", () => {
    const inv = forwardArgs("/s/doc/main.tex", 12, 3, "/s/doc/main.pdf", path.posix);
    expect(inv.cwd).toBe("/s/doc");
    expect(inv.inputs).toEqual(["main.tex", "/s/doc/main.tex"]);
  });

  it("builds inverse args from the PDF's directory with its basename", () => {
    const inv = inverseArgs("C:\\s\\doc\\main.pdf", 5, 100.5, 200.25, path.win32);
    expect(inv.cwd).toBe("C:\\s\\doc");
    expect(inv.args).toEqual(["edit", "-o", "5:100.5:200.25:main.pdf"]);
  });
});

describe("wire-format conformance", () => {
  it("no source file emits path.relative directly — apiRelative is the choke point", () => {
    // Every sandbox-relative path the API emits must go through apiRelative/
    // toApiPath (forward slashes on every platform). A bare path.relative in
    // src/ would ship backslash paths to the frontend on Windows — this test
    // fails the build instead of a Windows user finding it. Allowed:
    // sandbox-fs.ts (defines the helpers; isUserVisible's internal use).
    const srcDir = fileURLToPath(new URL("../src/", import.meta.url));
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const abs = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name !== "node_modules" && entry.name !== ".venv") walk(abs);
        } else if (/\.(ts|mts|mjs)$/.test(entry.name)) {
          if (path.basename(abs) === "sandbox-fs.ts") continue;
          if (fs.readFileSync(abs, "utf-8").includes("path.relative(")) {
            offenders.push(path.relative(srcDir, abs));
          }
        }
      }
    };
    walk(srcDir);
    expect(offenders).toEqual([]);
  });
});
