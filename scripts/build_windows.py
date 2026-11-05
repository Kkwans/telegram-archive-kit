#!/usr/bin/env python3
"""Reproducible Win64 build for both clients.

Targets:
  console  -> TelegramArchiveKit-Console.exe (Windows CUI, subsystem 3)
  desktop  -> TelegramArchiveKit.exe         (Windows GUI, subsystem 2)

The console module keeps its zero-dependency, offline build. The desktop module
lives in app/src/desktop and is built separately so `go test ./...` in app/src
never downloads Wails.
"""
from __future__ import annotations
import argparse
import hashlib
import os
import pathlib
import re
import subprocess
import sys
import zipfile

root = pathlib.Path(__file__).resolve().parents[1]
src = root / "app" / "src"
desktop_src = src / "desktop"
env = dict(os.environ, GOOS="windows", GOARCH="amd64", CGO_ENABLED="0")

TARGETS = {
    "console": dict(
        cwd=src,
        out=root / "TelegramArchiveKit-Console.exe",
        tags="",
        ldflags="-s -w",
        subsystem=3,
    ),
    "desktop": dict(
        cwd=desktop_src,
        out=root / "TelegramArchiveKit.exe",
        tags="production",
        ldflags="-s -w -H windowsgui",
        subsystem=2,
    ),
}


def run(*args: str, cwd: pathlib.Path = src, env=None) -> None:
    print("+", " ".join(str(a) for a in args), flush=True)
    subprocess.run([str(a) for a in args], cwd=cwd, env=env, check=True)


def build_tui() -> None:
    # Tests and vet run once, against the console module only.
    run("go", "test", "./...")
    run("go", "vet", "./...", env=env)


def build_frontend() -> None:
    """Build the embedded React UI. Skipped only with --skip-frontend."""
    frontend = desktop_src / "frontend"
    npm = "npm.cmd" if os.name == "nt" else "npm"
    if not (frontend / "node_modules").exists():
        run(npm, "ci", cwd=frontend)
    run(npm, "run", "build", cwd=frontend)


def build_target(name: str) -> pathlib.Path:
    t = TARGETS[name]
    if name == "desktop":
        run("go", "mod", "tidy", cwd=desktop_src)
        run("go", "vet", "./...", cwd=desktop_src, env=env)
    ldflags = t["ldflags"]
    cmd = ["go", "build", "-trimpath", f"-ldflags={ldflags}"]
    if t["tags"]:
        cmd += ["-tags", t["tags"]]
    cmd += ["-o", t["out"], "."]
    run(*cmd, cwd=t["cwd"], env=env)
    run(
        sys.executable,
        root / "scripts" / "check_windows_exe.py",
        t["out"],
        "--subsystem",
        str(t["subsystem"]),
    )
    return t["out"]


def project_version() -> str:
    text = (src / "internal" / "model" / "model.go").read_text(encoding="utf-8")
    match = re.search(r'Version\s*=\s*"([^"]+)"', text)
    return match.group(1) if match else "0.0"


def package_zip(outputs: list[pathlib.Path]) -> pathlib.Path:
    version = project_version()
    dist = root / "dist"
    dist.mkdir(exist_ok=True)
    zpath = dist / f"TelegramArchiveKit_v{version}_windows-x64.zip"
    docs = [
        root / "README.md",
        root / "CHANGELOG.md",
        root / "LICENSE",
        root / "docs" / "USAGE.md",
        root / "docs" / "TROUBLESHOOTING.md",
        root / "docs" / "DATA_FORMAT.md",
        root / "docs" / "THIRD_PARTY.md",
        root / "docs" / "ONLINE_TDL_3.0.md",
        root / "docs" / "STORAGE_SQLITE.md",
    ]
    with zipfile.ZipFile(zpath, "w", zipfile.ZIP_DEFLATED) as z:
        for out in outputs:
            z.write(out, out.name)
        for doc in docs:
            if doc.exists():
                z.write(doc, doc.name)
    digest = hashlib.sha256(zpath.read_bytes()).hexdigest()
    print(f"ZIP: {zpath}")
    print(f"SHA-256: {digest}")
    return zpath


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("--target", choices=("console", "desktop", "all"), default="all")
    p.add_argument("--skip-frontend", action="store_true", help="reuse frontend/dist")
    p.add_argument("--zip", action="store_true", help="package both clients and docs into dist/")
    args = p.parse_args()
    if args.zip and args.target != "all":
        raise SystemExit("--zip requires --target all")

    if args.target in ("console", "all"):
        build_tui()
    outputs = []
    if args.target == "console":
        outputs.append(build_target("console"))
    elif args.target == "desktop":
        if not args.skip_frontend:
            build_frontend()
        outputs.append(build_target("desktop"))
    else:
        outputs.append(build_target("console"))
        if not args.skip_frontend:
            build_frontend()
        outputs.append(build_target("desktop"))

    for out in outputs:
        print("Build completed:", out)
    if args.zip:
        package_zip(outputs)


if __name__ == "__main__":
    main()
