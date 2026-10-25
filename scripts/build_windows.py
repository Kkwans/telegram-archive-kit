#!/usr/bin/env python3
"""Reproducible Win64 console release build. Requires Python 3 and Go."""
from __future__ import annotations
import os
import pathlib
import subprocess
import sys

root = pathlib.Path(__file__).resolve().parents[1]
src = root / 'app' / 'src'
exe = root / 'TelegramArchiveKit.exe'
env = dict(os.environ, GOOS='windows', GOARCH='amd64', CGO_ENABLED='0')

def run(*args: str, env=None) -> None:
    print('+', ' '.join(args), flush=True)
    subprocess.run(args, cwd=src, env=env, check=True)

run('go', 'test', './...')  # native-host unit tests
run('go', 'vet', './...', env=env)
# IMPORTANT: no -H=windowsgui. This application needs a console to read keyboard events.
run('go', 'build', '-trimpath', '-ldflags=-s -w', '-o', str(exe), '.', env=env)
run(sys.executable, str(root / 'scripts' / 'check_windows_exe.py'), str(exe))
print('Build completed:', exe)
