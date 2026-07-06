import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { applyEnvFile } from "../../env-file.mjs";

const setKeys: string[] = [];

function loadEnv(content: string, opts?: { override?: boolean }): boolean {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "kady-env-")), ".env");
  fs.writeFileSync(file, content);
  const ok = applyEnvFile(file, opts);
  fs.rmSync(path.dirname(file), { recursive: true, force: true });
  return ok;
}

afterEach(() => {
  for (const k of setKeys.splice(0)) delete process.env[k];
});

function track(...keys: string[]) {
  setKeys.push(...keys);
  for (const k of keys) delete process.env[k];
}

describe("applyEnvFile", () => {
  it("parses bare KEY=VALUE and strips matching quotes", () => {
    track("KADY_T_A", "KADY_T_B", "KADY_T_C");
    loadEnv('KADY_T_A=plain\nKADY_T_B="quoted value"\nKADY_T_C=\'single\'');
    expect(process.env.KADY_T_A).toBe("plain");
    expect(process.env.KADY_T_B).toBe("quoted value");
    expect(process.env.KADY_T_C).toBe("single");
  });

  it("handles `export KEY=value` lines like bash source did", () => {
    track("KADY_T_EXPORTED");
    loadEnv("export KADY_T_EXPORTED=sk-or-123");
    expect(process.env.KADY_T_EXPORTED).toBe("sk-or-123");
    expect(process.env["export KADY_T_EXPORTED"]).toBeUndefined();
  });

  it("strips unquoted inline comments but keeps # inside values and quotes", () => {
    track("KADY_T_CMT", "KADY_T_FRAG", "KADY_T_QCMT");
    loadEnv('KADY_T_CMT=value # my key\nKADY_T_FRAG=http://x/a#frag\nKADY_T_QCMT="kept # inside" # trailing');
    expect(process.env.KADY_T_CMT).toBe("value");
    expect(process.env.KADY_T_FRAG).toBe("http://x/a#frag");
    expect(process.env.KADY_T_QCMT).toBe("kept # inside");
  });

  it("skips comments, blanks, and lines without '='", () => {
    track("KADY_T_OK");
    loadEnv("# comment\n\nnot-an-assignment\nKADY_T_OK=1");
    expect(process.env.KADY_T_OK).toBe("1");
  });

  it("respects precedence: fill-if-undefined by default, override on demand", () => {
    track("KADY_T_PREC");
    process.env.KADY_T_PREC = "ambient";
    loadEnv("KADY_T_PREC=from-file");
    expect(process.env.KADY_T_PREC).toBe("ambient");
    loadEnv("KADY_T_PREC=from-file", { override: true });
    expect(process.env.KADY_T_PREC).toBe("from-file");
  });

  it("tolerates CRLF line endings", () => {
    track("KADY_T_CRLF");
    loadEnv("KADY_T_CRLF=v\r\n");
    expect(process.env.KADY_T_CRLF).toBe("v");
  });

  it("returns false for a missing file", () => {
    expect(applyEnvFile(path.join(os.tmpdir(), "kady-definitely-missing.env"))).toBe(false);
  });
});
