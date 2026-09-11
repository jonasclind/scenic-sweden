"""Write-path guard.

The T7 also holds an irreplaceable, unbacked-up photo and video library. Every
write this project makes is asserted to land under DATA_ROOT rather than merely
intended to. Nothing in this codebase deletes anything.
"""
from __future__ import annotations

import shutil
from pathlib import Path

VOLUME = Path("/Volumes/T7")
DATA_ROOT = VOLUME / "scenic"

# refuse to run if the volume is this close to full, so we can never be the
# reason a write of theirs fails
RESERVE_GB = 100.0


def guard(path) -> Path:
    """Return `path` if it lies under DATA_ROOT, otherwise raise."""
    p = Path(path).expanduser().resolve()
    root = DATA_ROOT.resolve()
    if p != root and root not in p.parents:
        raise PermissionError(
            f"refusing to write outside {root}\n  attempted: {p}")
    return p


def ensure_dir(path) -> Path:
    p = guard(path)
    p.mkdir(parents=True, exist_ok=True)
    return p


def check_free_space(need_gb: float = 0.0) -> float:
    """Free GB on the volume. Raises if the write would eat into the reserve."""
    free_gb = shutil.disk_usage(VOLUME).free / 1e9
    if free_gb - need_gb < RESERVE_GB:
        raise RuntimeError(
            f"{VOLUME} has {free_gb:.0f} GB free; writing {need_gb:.0f} GB would "
            f"leave less than the {RESERVE_GB:.0f} GB reserve. Refusing.")
    return free_gb
