#!/usr/bin/env python3
"""Release gate for TelegramArchiveKit binaries.

PE32+ machine must be x86-64 (0x8664). Subsystem is checked explicitly so the
console client (CUI, 3) and the desktop client (GUI, 2) can both be verified.
The --reference option additionally asserts parity with a previously working EXE.
"""
from __future__ import annotations
import argparse
import hashlib
import pathlib
import struct


def inspect(path: pathlib.Path) -> tuple[int, int, int]:
    raw = path.read_bytes()
    if raw[:2] != b'MZ' or len(raw) < 0x40:
        raise ValueError(f'{path}: missing DOS MZ header')
    pe_offset = struct.unpack_from('<I', raw, 0x3C)[0]
    if raw[pe_offset:pe_offset+4] != b'PE\x00\x00':
        raise ValueError(f'{path}: missing PE signature')
    machine = struct.unpack_from('<H', raw, pe_offset + 4)[0]
    opt_offset = pe_offset + 4 + 20
    magic = struct.unpack_from('<H', raw, opt_offset)[0]
    subsystem = struct.unpack_from('<H', raw, opt_offset + 68)[0]
    return machine, magic, subsystem


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument('exe', type=pathlib.Path)
    p.add_argument('--reference', type=pathlib.Path)
    p.add_argument('--subsystem', type=int, default=3, choices=(2, 3),
                   help='2 = Windows GUI, 3 = console (default)')
    args = p.parse_args()
    actual = inspect(args.exe)
    expected = (0x8664, 0x20B, args.subsystem)
    kind = 'GUI' if args.subsystem == 2 else 'console'
    print(f'{args.exe}: machine=0x{actual[0]:04x}, magic=0x{actual[1]:03x}, subsystem={actual[2]}')
    if actual != expected:
        raise SystemExit(f'RELEASE BLOCKED: expected Win64 PE32+ {kind.upper()} executable {expected}; got {actual}')
    if args.reference:
        baseline = inspect(args.reference)
        print(f'Reference {args.reference}: machine=0x{baseline[0]:04x}, magic=0x{baseline[1]:03x}, subsystem={baseline[2]}')
        if baseline != actual:
            raise SystemExit(f'RELEASE BLOCKED: startup subsystem differs from known-good reference: {baseline} vs {actual}')
    print(f'PE startup type: PASS (Windows {kind})')
    print('SHA-256:', hashlib.sha256(args.exe.read_bytes()).hexdigest())


if __name__ == '__main__':
    main()
