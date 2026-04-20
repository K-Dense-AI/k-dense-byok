import { describe, it, expect } from "vitest";
import { hasDirectoryEntries, traverseDroppedEntries } from "./directory-upload";

type FakeEntry = {
  isFile?: boolean;
  isDirectory?: boolean;
  name: string;
  file?: (cb: (f: File) => void, err: (e: unknown) => void) => void;
  createReader?: () => {
    readEntries: (cb: (list: FakeEntry[]) => void) => void;
  };
};

function makeFileEntry(name: string, content: string): FakeEntry {
  return {
    isFile: true,
    isDirectory: false,
    name,
    file: (cb) => cb(new File([content], name)),
  };
}

function makeDirEntry(name: string, children: FakeEntry[]): FakeEntry {
  let returned = false;
  return {
    isFile: false,
    isDirectory: true,
    name,
    createReader: () => ({
      readEntries: (cb) => {
        if (returned) {
          cb([]);
        } else {
          returned = true;
          cb(children);
        }
      },
    }),
  };
}

function makeItems(entries: FakeEntry[]): DataTransferItemList {
  const list = entries.map((e) => ({
    webkitGetAsEntry: () => e as unknown as FileSystemEntry,
  }));
  return Object.assign(list, { length: list.length }) as unknown as DataTransferItemList;
}

describe("hasDirectoryEntries", () => {
  it("returns true when at least one entry is a directory", () => {
    const items = makeItems([makeFileEntry("a.txt", "x"), makeDirEntry("d", [])]);
    expect(hasDirectoryEntries(items)).toBe(true);
  });

  it("returns false when all entries are files", () => {
    const items = makeItems([makeFileEntry("a.txt", "x")]);
    expect(hasDirectoryEntries(items)).toBe(false);
  });
});

describe("traverseDroppedEntries", () => {
  it("returns flat files with their paths (empty prefix for top-level files)", async () => {
    const items = makeItems([makeFileEntry("a.txt", "aaa")]);
    const { files, paths } = await traverseDroppedEntries(items);
    expect(files.map((f) => f.name)).toEqual(["a.txt"]);
    expect(paths).toEqual([""]);
  });

  it("walks a nested directory", async () => {
    const items = makeItems([
      makeDirEntry("dir", [
        makeFileEntry("a.txt", "aaa"),
        makeDirEntry("sub", [makeFileEntry("b.txt", "bbb")]),
      ]),
    ]);
    const { files, paths } = await traverseDroppedEntries(items);
    const names = files.map((f) => f.name).sort();
    expect(names).toEqual(["a.txt", "b.txt"]);
    expect(paths.sort()).toEqual(["dir/a.txt", "dir/sub/b.txt"]);
  });
});
