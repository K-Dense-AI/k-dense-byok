/**
 * GPU probe parsers. The point of these is the AMD pair: rocm-smi and amd-smi
 * rename fields between ROCm releases and report "N/A" for counters a platform
 * doesn't support (notably utilization under ROCm on Windows), so the parsers
 * match keys by substring and every field is independently optional. Fixtures
 * below are real output shapes, including the renamed-key variants.
 */
import { describe, expect, it } from "vitest";
import {
  firstJsonValue,
  parseAmdSmiMetric,
  parseAmdSmiName,
  parseNvidiaSmi,
  parseRocmSmi,
} from "../src/system-stats.ts";

const MB = 1024 * 1024;

describe("parseNvidiaSmi", () => {
  it("reads the first CSV row", () => {
    expect(parseNvidiaSmi("NVIDIA GeForce RTX 4090, 37, 2048, 24564\n")).toEqual({
      name: "NVIDIA GeForce RTX 4090",
      utilizationPct: 37,
      memUsedBytes: 2048 * MB,
      memTotalBytes: 24564 * MB,
    });
  });

  it("ignores all but the first GPU", () => {
    const out = "GPU A, 10, 1, 2\nGPU B, 90, 3, 4\n";
    expect(parseNvidiaSmi(out)?.name).toBe("GPU A");
  });

  it("returns null on empty output", () => {
    expect(parseNvidiaSmi("   \n")).toBeNull();
  });
});

describe("parseRocmSmi", () => {
  const rocm6 = JSON.stringify({
    card0: {
      "GPU use (%)": "42",
      "VRAM Total Memory (B)": "17163091968",
      "VRAM Total Used Memory (B)": "1073741824",
      "Card Series": "Navi 48 [Radeon RX 9070/9070 XT]",
      "Card Model": "0x7550",
      "Card Vendor": "Advanced Micro Devices, Inc. [AMD/ATI]",
    },
  });

  it("reads utilization, VRAM and product name", () => {
    expect(parseRocmSmi(rocm6)).toEqual({
      name: "Navi 48 [Radeon RX 9070/9070 XT]",
      utilizationPct: 42,
      memUsedBytes: 1073741824,
      memTotalBytes: 17163091968,
    });
  });

  it("does not mistake used VRAM for total", () => {
    const gpu = parseRocmSmi(rocm6);
    expect(gpu?.memTotalBytes).toBeGreaterThan(gpu!.memUsedBytes!);
  });

  it("keeps VRAM when the utilization counter is unsupported", () => {
    const out = JSON.stringify({
      card0: {
        "GPU use (%)": "N/A",
        "VRAM Total Memory (B)": "17163091968",
        "VRAM Total Used Memory (B)": "524288000",
      },
    });
    expect(parseRocmSmi(out)).toEqual({
      name: "AMD GPU",
      utilizationPct: null,
      memUsedBytes: 524288000,
      memTotalBytes: 17163091968,
    });
  });

  it("accepts a renamed product-name key", () => {
    const out = JSON.stringify({
      card0: { "GPU use (%)": "0", "Market Name": "Radeon RX 9070 XT" },
    });
    expect(parseRocmSmi(out)?.name).toBe("Radeon RX 9070 XT");
  });

  it("prefers a real name over the PCI device id", () => {
    const out = JSON.stringify({ card0: { "GPU use (%)": "5", "Card Model": "0x7550" } });
    expect(parseRocmSmi(out)?.name).toBe("AMD GPU");
  });

  it("reports card0 when several cards are present", () => {
    const out = JSON.stringify({
      card10: { "GPU use (%)": "90", "Market Name": "Second" },
      card0: { "GPU use (%)": "1", "Market Name": "First" },
      card2: { "GPU use (%)": "50", "Market Name": "Third" },
    });
    expect(parseRocmSmi(out)?.name).toBe("First");
  });

  it("converts a stated non-byte VRAM unit", () => {
    const out = JSON.stringify({
      card0: { "GPU use (%)": "1", "VRAM Total Memory (MB)": "16368" },
    });
    expect(parseRocmSmi(out)?.memTotalBytes).toBe(16368 * MB);
  });

  it("survives a warning banner ahead of the JSON", () => {
    const out = `WARNING: rsmi_dev_gpu_metrics_info_get failed\n${rocm6}\n`;
    expect(parseRocmSmi(out)?.utilizationPct).toBe(42);
  });

  it("returns null when nothing usable came back", () => {
    expect(parseRocmSmi(JSON.stringify({ card0: { "GPU use (%)": "N/A" } }))).toBeNull();
    expect(parseRocmSmi(JSON.stringify({}))).toBeNull();
    expect(parseRocmSmi("not json at all")).toBeNull();
  });
});

describe("parseAmdSmiMetric", () => {
  const amdSmi = JSON.stringify([
    {
      gpu: 0,
      usage: {
        gfx_activity: { value: 63, unit: "%" },
        umc_activity: { value: 12, unit: "%" },
      },
      mem_usage: {
        total_vram: { value: 16368, unit: "MB" },
        used_vram: { value: 4096, unit: "MB" },
        free_vram: { value: 12272, unit: "MB" },
        total_visible_vram: { value: 16368, unit: "MB" },
      },
    },
    { gpu: 1, usage: { gfx_activity: { value: 99, unit: "%" } } },
  ]);

  it("reads the first GPU's activity and VRAM, unit-converted", () => {
    expect(parseAmdSmiMetric(amdSmi)).toEqual({
      utilizationPct: 63,
      memUsedBytes: 4096 * MB,
      memTotalBytes: 16368 * MB,
    });
  });

  it("ignores visible/free VRAM when reading the total", () => {
    expect(parseAmdSmiMetric(amdSmi)?.memTotalBytes).toBe(16368 * MB);
  });

  it("keeps activity when the memory group is absent", () => {
    const out = JSON.stringify([{ gpu: 0, usage: { gfx_activity: { value: 7, unit: "%" } } }]);
    expect(parseAmdSmiMetric(out)).toEqual({
      utilizationPct: 7,
      memUsedBytes: null,
      memTotalBytes: null,
    });
  });

  it("accepts bare numbers instead of {value, unit} wrappers", () => {
    const out = JSON.stringify([{ gpu: 0, gfx_activity: 21, used_vram: 100, total_vram: 200 }]);
    // No unit anywhere -- bytes is the documented fallback.
    expect(parseAmdSmiMetric(out)).toEqual({
      utilizationPct: 21,
      memUsedBytes: 100,
      memTotalBytes: 200,
    });
  });

  it("returns null when every field is N/A", () => {
    const out = JSON.stringify([{ gpu: 0, usage: { gfx_activity: { value: "N/A" } } }]);
    expect(parseAmdSmiMetric(out)).toBeNull();
  });
});

describe("parseAmdSmiName", () => {
  it("reads the ASIC market name", () => {
    const out = JSON.stringify([
      { gpu: 0, asic: { market_name: "Radeon RX 9070 XT", vendor_id: "0x1002" } },
    ]);
    expect(parseAmdSmiName(out)).toBe("Radeon RX 9070 XT");
  });

  it("falls back to a board product name", () => {
    const out = JSON.stringify([
      { gpu: 0, asic: { market_name: "N/A" }, board: { product_name: "Instinct MI300X" } },
    ]);
    expect(parseAmdSmiName(out)).toBe("Instinct MI300X");
  });

  it("returns null when no name is present", () => {
    expect(parseAmdSmiName(JSON.stringify([{ gpu: 0 }]))).toBeNull();
    expect(parseAmdSmiName("")).toBeNull();
  });
});

describe("firstJsonValue", () => {
  it("parses clean JSON", () => {
    expect(firstJsonValue('{"a":1}')).toEqual({ a: 1 });
  });

  it("skips leading non-JSON noise", () => {
    expect(firstJsonValue('WARNING: something\n[{"a":1}]')).toEqual([{ a: 1 }]);
  });

  it("returns null when there is no JSON", () => {
    expect(firstJsonValue("nope")).toBeNull();
    expect(firstJsonValue("")).toBeNull();
  });
});
