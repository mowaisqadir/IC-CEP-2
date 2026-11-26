#!/usr/bin/env python3
"""
tools/build_precache.py
Scans frontend/ and rewrites the APP_SHELL precache list in frontend/sw.js
so every file under css/, js/, icons/, plus index.html and manifest.json is
always included.

Usage:
    python tools/build_precache.py
"""

from pathlib import Path
import re
import sys

ROOT_DIR = Path(__file__).resolve().parent.parent
FRONTEND_DIR = ROOT_DIR / "frontend"
SW_PATH = FRONTEND_DIR / "sw.js"

DEXIE_CDN_URL = "https://cdn.jsdelivr.net/npm/dexie@4/dist/dexie.min.js"

START_MARKER = "// <PRECACHE_START>"
END_MARKER = "// <PRECACHE_END>"


def collect_precache_urls(frontend_dir: Path) -> list[str]:
    urls: list[str] = ["/", "/index.html", "/manifest.json"]

    for folder in ("css", "js", "icons"):
        sub = frontend_dir / folder
        if not sub.exists():
            continue
        files = sorted(
            p for p in sub.rglob("*")
            if p.is_file() and not p.name.startswith(".")
        )
        for p in files:
            rel = p.relative_to(frontend_dir).as_posix()
            urls.append(f"/{rel}")

    urls.append(DEXIE_CDN_URL)
    return urls


def update_sw_precache(sw_path: Path, urls: list[str]) -> None:
    content = sw_path.read_text(encoding="utf-8")

    lines = ["const APP_SHELL = ["]
    for u in urls:
        lines.append(f"  '{u}',")
    lines.append("];")
    replacement = f"{START_MARKER}\n" + "\n".join(lines) + f"\n{END_MARKER}"

    pattern = re.compile(
        re.escape(START_MARKER) + r".*?" + re.escape(END_MARKER),
        re.DOTALL,
    )
    if not pattern.search(content):
        raise RuntimeError(
            f"Could not find {START_MARKER} ... {END_MARKER} markers in {sw_path}"
        )

    updated = pattern.sub(replacement, content, count=1)
    sw_path.write_text(updated, encoding="utf-8")


def main() -> int:
    if not SW_PATH.exists():
        print(f"Error: {SW_PATH} not found", file=sys.stderr)
        return 1

    urls = collect_precache_urls(FRONTEND_DIR)
    update_sw_precache(SW_PATH, urls)
    print(f"Updated {SW_PATH} with {len(urls)} precache entries.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

