// @vitest-environment node
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";

type UnoUrl = { Complete: string };
type StatusListener = { statusChanged: (event: { IsEnabled: boolean }) => void };
type Dispatch = {
  dispatch: (url: UnoUrl) => void;
  addStatusListener: (listener: StatusListener, url: UnoUrl) => void;
};
type Interceptor = {
  getInterceptedURLs: () => string[];
  setSlaveDispatchProvider: (provider: { queryDispatch: () => Dispatch }) => void;
  queryDispatch: (url: UnoUrl, target: string, flags: number) => Dispatch;
};

/** Run the shipped adapter with a small UNO boundary, including URL registration. */
async function loadAdapter(readOnly: boolean, kind = "docx") {
  let interceptor: Interceptor | undefined;
  const nativeDispatch = { dispatch: vi.fn(), addStatusListener: vi.fn() };
  const frame = {
    LayoutManager: { setVisible: vi.fn() },
    getContainerWindow: () => ({}),
    registerDispatchProviderInterceptor(value: Interceptor) {
      interceptor = value;
      value.setSlaveDispatchProvider({ queryDispatch: () => nativeDispatch });
    },
    queryDispatch(url: UnoUrl, target = "_self", flags = 0): Dispatch {
      const registered = interceptor?.getInterceptedURLs().some(pattern =>
        pattern.endsWith("*") ? url.Complete.startsWith(pattern.slice(0, -1)) : pattern === url.Complete);
      return registered ? interceptor!.queryDispatch(url, target, flags) : nativeDispatch;
    },
  };
  const controller = { getFrame: () => frame, addSelectionChangeListener: vi.fn() };
  const model = { getCurrentController: () => controller, addModifyListener: vi.fn() };
  const settings = {
    setPropertyValue: vi.fn(), commitChanges: vi.fn(), hasByName: () => true,
    getByName: (): unknown => settings,
  };
  class Struct {
    constructor(fields: object) { Object.assign(this, fields); }
  }
  const port: { onmessage?: (event: { data: Record<string, unknown> }) => void; postMessage: ReturnType<typeof vi.fn> } = {
    postMessage: vi.fn(),
  };
  const zeta = {
    getUnoComponentContext: () => ({}),
    unoObject: (_interfaces: unknown[], implementation: unknown) => implementation,
    Any: class { constructor(_type: unknown, _value: unknown) {} },
    type: { short: "short", long: "long" },
    mainPort: port,
    uno: { com: { sun: { star: {
      beans: { PropertyValue: Struct },
      configuration: { ConfigurationProvider: { create: () => ({ createInstanceWithArguments: () => settings }) } },
      frame: {
        Desktop: { create: () => ({ loadComponentFromURL: () => model }) },
        DispatchHelper: { create: () => ({ executeDispatch: (_frame: unknown, command: string) => {
          const url = { Complete: command };
          frame.queryDispatch(url).dispatch(url);
        } }) },
        FeatureStateEvent: Struct,
      },
      util: { URL: Struct }, view: {},
    } } } },
  };
  await runInNewContext(readFileSync(resolve(process.cwd(), "public/office/thread.js"), "utf8"), {
    Module: { zetajs: Promise.resolve(zeta) }, console,
  });
  port.onmessage!({ data: { cmd: "load", filename: `document.${kind}`, readOnly, dark: false } });
  expect(port.postMessage).toHaveBeenCalledWith({ cmd: "opened" });
  port.postMessage.mockClear();
  return { port, frame, nativeDispatch };
}

describe("Office native file commands", () => {
  it.each(["docx", "xlsx", "pptx"])("routes Save and Save All through project saves for %s", async kind => {
    const { port, frame, nativeDispatch } = await loadAdapter(false, kind);
    for (const command of [".uno:Save", ".uno:SaveAll"]) {
      const statusChanged = vi.fn();
      frame.queryDispatch({ Complete: command }).addStatusListener({ statusChanged }, { Complete: command });
      expect(statusChanged).toHaveBeenCalledWith(expect.objectContaining({ IsEnabled: true }));
      port.onmessage!({ data: { cmd: "command", command } });
    }
    expect(port.postMessage.mock.calls).toEqual([[{ cmd: "save-request" }], [{ cmd: "save-request" }]]);
    expect(nativeDispatch.dispatch).not.toHaveBeenCalled();
  });

  it("disables both save commands for read-only documents, while retaining copy downloads", async () => {
    const { port, frame, nativeDispatch } = await loadAdapter(true);
    for (const command of [".uno:Save", ".uno:SaveAll"]) {
      const statusChanged = vi.fn();
      frame.queryDispatch({ Complete: command }).addStatusListener({ statusChanged }, { Complete: command });
      expect(statusChanged).toHaveBeenCalledWith(expect.objectContaining({ IsEnabled: false }));
      port.onmessage!({ data: { cmd: "command", command } });
    }
    expect(port.postMessage).not.toHaveBeenCalled();
    expect(nativeDispatch.dispatch).not.toHaveBeenCalled();
    port.onmessage!({ data: { cmd: "command", command: ".uno:SaveACopy" } });
    expect(port.postMessage).toHaveBeenCalledWith({ cmd: "download-request" });
  });

  it("continues forwarding document-editing commands to LibreOffice", async () => {
    const { port, nativeDispatch } = await loadAdapter(false);
    port.onmessage!({ data: { cmd: "command", command: ".uno:Bold" } });
    expect(nativeDispatch.dispatch).toHaveBeenCalledWith({ Complete: ".uno:Bold" });
    expect(port.postMessage).not.toHaveBeenCalled();
  });

  it.each([".uno:Open", ".uno:OpenFromCalc", ".uno:OpenFromWriter"])("disables native %s instead of replacing the host's document", async command => {
    const { port, frame, nativeDispatch } = await loadAdapter(false);
    const statusChanged = vi.fn();
    frame.queryDispatch({ Complete: command }).addStatusListener({ statusChanged }, { Complete: command });
    expect(statusChanged).toHaveBeenCalledWith(expect.objectContaining({ IsEnabled: false }));
    port.onmessage!({ data: { cmd: "command", command } });
    expect(nativeDispatch.dispatch).not.toHaveBeenCalled();
    expect(port.postMessage).not.toHaveBeenCalled();
  });
});
