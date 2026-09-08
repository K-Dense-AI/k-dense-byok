import { describe, expect, it } from "vitest";
import { NotFoundError, type ModalClient } from "modal";
import { SdkModalAdapter } from "../src/modal/adapter.ts";

/** Minimal stand-in for the parts of the Modal client `prepareEnvironment` touches. */
function stubClient(options: { published: boolean }) {
  const calls: string[] = [];
  const image: any = {
    imageId: "im-built",
    dockerfileCommands: () => image,
    build: async () => {
      calls.push("build");
      return image;
    },
    publish: async (name: string) => {
      calls.push(`publish:${name}`);
    },
  };
  const client = {
    apps: { fromName: async () => ({ appId: "ap-1" }) },
    volumes: { fromName: async () => ({}) },
    images: {
      fromRegistry: () => image,
      fromName: async (name: string) => {
        calls.push(`fromName:${name}`);
        if (!options.published) throw new NotFoundError(`Image '${name}' not found`);
        return { ...image, imageId: "im-published" };
      },
    },
    close() {},
  } as unknown as ModalClient;
  return { client, calls };
}

describe("SdkModalAdapter named environments", () => {
  it("reuses a previously published environment instead of rebuilding it", async () => {
    const { client, calls } = stubClient({ published: true });
    const adapter = new SdkModalAdapter(undefined, undefined, client);
    const environment = await adapter.prepareEnvironment("proj", { pip: ["numpy"] }, "python:3.12", "My Env", "none");
    expect(environment.reusedSnapshot).toBe(true);
    expect(environment.imageId).toBe("im-published");
    expect(environment.snapshotName).toMatch(/^kady-proj-my-env:[0-9a-f]{16}$/);
    expect(calls.filter((call) => call === "build")).toHaveLength(0);
    expect(calls.some((call) => call.startsWith("publish:"))).toBe(false);
  });

  it("builds and publishes when nothing was published under that name yet", async () => {
    const { client, calls } = stubClient({ published: false });
    const adapter = new SdkModalAdapter(undefined, undefined, client);
    const environment = await adapter.prepareEnvironment("proj", { pip: ["numpy"] }, "python:3.12", "My Env", "none");
    expect(environment.reusedSnapshot).toBe(false);
    expect(calls).toEqual([
      expect.stringMatching(/^fromName:kady-proj-my-env:/),
      "build",
      expect.stringMatching(/^publish:kady-proj-my-env:/),
    ]);
  });

  it("applies one name rule so metadata files and Modal image names agree", async () => {
    const { client } = stubClient({ published: true });
    const adapter = new SdkModalAdapter(undefined, undefined, client);
    const long = "A_very_long_environment_name_beyond_twenty_four_chars";
    const environment = await adapter.prepareEnvironment("proj", undefined, "python:3.12", long, "none");
    expect(environment.snapshotName!.split(":")[0]).toBe(`kady-proj-${"a-very-long-environment-".slice(0, 24)}`);
  });
});
