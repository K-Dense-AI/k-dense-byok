from __future__ import annotations

from pathlib import Path

USER_HIDDEN_NAMES = {"GEMINI.md", "uv.lock"}
_MAX_VISIBLE_CONTEXT_ENTRIES = 300


def is_user_visible_path(path: Path, sandbox_root: Path) -> bool:
    """Return whether *path* is shown in the sandbox file tree."""
    try:
        rel = path.relative_to(sandbox_root)
    except ValueError:
        return False
    if not rel.parts:
        return True
    if any(part.startswith(".") for part in rel.parts):
        return False
    if path.name in USER_HIDDEN_NAMES:
        return False
    if path.is_file() and path.name.endswith(".annotations.json"):
        return False
    return True


def iter_user_visible_paths(sandbox_root: Path, *, max_entries: int = _MAX_VISIBLE_CONTEXT_ENTRIES) -> tuple[list[str], bool]:
    """List user-visible sandbox paths in stable order.

    Returns ``(paths, truncated)``. Directories are suffixed with ``/`` so the
    expert can distinguish folders from files without inspecting hidden state.
    """
    if not sandbox_root.exists():
        return [], False

    visible: list[str] = []
    truncated = False

    def walk(directory: Path) -> None:
        nonlocal truncated
        if truncated:
            return
        try:
            entries = sorted(directory.iterdir(), key=lambda p: (p.is_file(), p.name.lower()))
        except PermissionError:
            return

        for entry in entries:
            if not is_user_visible_path(entry, sandbox_root):
                continue
            rel = entry.relative_to(sandbox_root).as_posix()
            visible.append(f"{rel}/" if entry.is_dir() else rel)
            if len(visible) >= max_entries:
                truncated = True
                return
            if entry.is_dir():
                walk(entry)
                if truncated:
                    return

    walk(sandbox_root)
    return visible, truncated
