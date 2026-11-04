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
import os
import pathlib
import subprocess
import sys

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


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("--target", choices=("console", "desktop", "all"), default="all")
    p.add_argument("--skip-frontend", action="store_true", help="reuse frontend/dist")
    args = p.parse_args()

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


if __name__ == "__main__":
    main()
