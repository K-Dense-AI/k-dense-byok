import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { ComputePickerBody, type ModalInstance } from "./compute-selector";
import type { ModalCatalog } from "@/lib/modal-jobs";

const catalog: ModalCatalog = {
  modalConfigured: true,
  instances: [
    {
      id: "cpu-4",
      label: "4 CPU",
      gpu: null,
      gpuCount: 1,
      cpu: 4,
      memoryMiB: 8192,
      pricePerHour: 0.2,
      description: "General purpose CPU",
    },
    {
      id: "h100-2",
      label: "H100 pair",
      gpu: "H100",
      gpuCount: 2,
      maxGpuCount: 8,
      cpu: 16,
      memoryMiB: 131072,
      pricePerHour: 9.12,
      fallback: "a100-80gb-2",
      cache: "project",
    },
  ],
  defaults: {
    instanceId: "cpu-4",
    gpuCount: 1,
    fallback: null,
    cache: null,
    raw: {},
  },
};

describe("ComputePickerBody", () => {
  it("renders CPU, GPU count, fallback, cache, and estimated server prices", () => {
    render(
      <ComputePickerBody
        selected={null}
        onChange={() => {}}
        catalog={catalog}
      />,
    );

    expect(screen.getByRole("option", { name: /4 CPU/i })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: /H100 pair/i })).toHaveTextContent("2× H100");
    expect(screen.getByRole("option", { name: /H100 pair/i })).toHaveTextContent(
      "fallback a100-80gb-2",
    );
    expect(screen.getByRole("option", { name: /H100 pair/i })).toHaveTextContent(
      "cache project",
    );
    expect(screen.getByRole("option", { name: /H100 pair/i })).toHaveTextContent(
      "$9.12/hr est.",
    );
  });

  it("uses native option buttons and supports arrow-key listbox navigation", () => {
    render(
      <ComputePickerBody
        selected={null}
        onChange={() => {}}
        catalog={catalog}
      />,
    );
    const local = screen.getByRole("option", { name: /local/i });
    const cpu = screen.getByRole("option", { name: /4 CPU/i });
    local.focus();
    fireEvent.keyDown(screen.getByRole("listbox"), { key: "ArrowDown" });
    expect(cpu).toHaveFocus();
    fireEvent.keyDown(screen.getByRole("listbox"), { key: "End" });
    expect(screen.getByRole("option", { name: /H100 pair/i })).toHaveFocus();
  });

  it("selects authoritative catalog values", async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(
      <ComputePickerBody
        selected={null}
        onChange={onChange}
        catalog={catalog}
      />,
    );
    await user.click(screen.getByRole("option", { name: /H100 pair/i }));
    expect(onChange).toHaveBeenCalledWith(catalog.instances[1]);
  });

  it("updates GPU count and cache options on the selected target", async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(
      <ComputePickerBody
        selected={catalog.instances[1]}
        onChange={onChange}
        catalog={catalog}
      />,
    );
    await user.selectOptions(screen.getByRole("combobox", { name: "GPU count" }), "4");
    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ id: "h100-2", gpuCount: 4 }),
    );
    await user.selectOptions(screen.getByRole("combobox", { name: "Modal cache" }), "none");
    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ id: "h100-2", cache: "none" }),
    );
  });

  it("preserves a legacy persisted selection that is absent from the new catalog", () => {
    const legacy = {
      id: "a100-40gb",
      label: "A100 40GB",
      modalGpu: "A100-40GB",
      vram: 40,
      pricePerHour: 2.78,
      tier: "high",
      description: "Saved legacy resource",
    } as unknown as ModalInstance;
    render(
      <ComputePickerBody
        selected={legacy}
        onChange={() => {}}
        catalog={catalog}
      />,
    );
    const option = screen.getByRole("option", { name: /A100 40GB/i });
    expect(option).toHaveAttribute("aria-selected", "true");
    expect(option).toHaveTextContent("saved");
  });

  it("disables remote options until Modal is configured and surfaces catalog errors", () => {
    const onRefresh = vi.fn();
    render(
      <ComputePickerBody
        selected={null}
        onChange={() => {}}
        catalog={{ ...catalog, modalConfigured: false }}
        error="backend offline"
        onRefresh={onRefresh}
      />,
    );
    expect(screen.getByRole("option", { name: /4 CPU/i })).toBeDisabled();
    expect(screen.getByRole("alert")).toHaveTextContent("backend offline");
    fireEvent.click(screen.getByRole("button", { name: /retry/i }));
    expect(onRefresh).toHaveBeenCalledOnce();
  });
});
