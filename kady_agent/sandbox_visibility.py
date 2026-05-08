"""User-visible sandbox traversal.

Single source of truth for the rules that hide implementation files (dot-files,
``GEMINI.md``, ``uv.lock``, ``*.annotations.json``) from the file tree the
expert and UI see. Callers that want a flat list of visible paths consume
``user_visible_entries``; callers that want to use the same exclusion list in
other contexts (e.g. zip exports) read ``USER_HIDDEN_NAMES``.
"""

from __future__ import annotations

from pathlib import Path
from typing import Iterator

USER_HIDDEN_NAMES: frozenset[str] = frozenset({"GEMINI.md", "uv.lock"})


def _is_visible(path: Path, root: Path) -> bool:
    try:
        rel = path.relative_to(root)
    except ValueError:
        return False
    if not rel.parts:
        return True
    if any(part.startswith(".") for part in rel.parts):
        return False
    if path.name in USER_HIDDEN_NAMES:
        return False
    if path.name.endswith(".annotations.json"):
        return False
    return True


def user_visible_entries(
    root: Path,
    *,
    max_depth: int | None = None,
) -> Iterator[Path]:
    """Yield user-visible paths under *root* in depth-first, sorted order.

    Owns *both* recursion and filtering — callers must not re-implement either.
    Yields directories before their contents (pre-order). The root itself is
    not yielded. ``max_depth`` is measured from the root: ``max_depth=0`` yields
    only direct children, ``max_depth=1`` includes their children, etc.
    """

    if not root.exists():
        return

    def walk(directory: Path, depth: int) -> Iterator[Path]:
        try:
            entries = sorted(
                directory.iterdir(),
                key=lambda p: (p.is_file(), p.name.lower()),
            )
        except (PermissionError, OSError):
            return
        for entry in entries:
            if not _is_visible(entry, root):
                continue
            yield entry
            if entry.is_dir() and (max_depth is None or depth < max_depth):
                yield from walk(entry, depth + 1)

    yield from walk(root, 0)


__all__ = ["USER_HIDDEN_NAMES", "user_visible_entries"]
