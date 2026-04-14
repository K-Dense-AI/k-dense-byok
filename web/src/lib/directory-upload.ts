/**
 * Recursively traverses directory entries from a DataTransferItemList (drag-and-drop).
 * Returns flat arrays of files and their relative paths within the dropped directory.
 */

async function readAllEntries(reader: FileSystemDirectoryReader): Promise<FileSystemEntry[]> {
  const all: FileSystemEntry[] = [];
  let batch: FileSystemEntry[];
  do {
    batch = await new Promise<FileSystemEntry[]>((resolve, reject) =>
      reader.readEntries(resolve, reject),
    );
    all.push(...batch);
  } while (batch.length > 0);
  return all;
}

export async function traverseDroppedEntries(
  items: DataTransferItemList,
): Promise<{ files: File[]; paths: string[] }> {
  const files: File[] = [];
  const paths: string[] = [];

  async function walk(entry: FileSystemEntry, prefix: string) {
    if (entry.isFile) {
      const file = await new Promise<File>((resolve, reject) =>
        (entry as FileSystemFileEntry).file(resolve, reject),
      );
      files.push(file);
      paths.push(prefix ? `${prefix}/${entry.name}` : "");
    } else if (entry.isDirectory) {
      const dirPath = prefix ? `${prefix}/${entry.name}` : entry.name;
      const children = await readAllEntries(
        (entry as FileSystemDirectoryEntry).createReader(),
      );
      for (const child of children) await walk(child, dirPath);
    }
  }

  for (let i = 0; i < items.length; i++) {
    const entry = items[i].webkitGetAsEntry?.();
    if (entry) await walk(entry, "");
  }
  return { files, paths };
}

export function hasDirectoryEntries(items: DataTransferItemList): boolean {
  for (let i = 0; i < items.length; i++) {
    if (items[i].webkitGetAsEntry?.()?.isDirectory) return true;
  }
  return false;
}
