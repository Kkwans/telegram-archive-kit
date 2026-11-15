import base64
import os
import pwd
import re
import shutil
import struct
import subprocess
import sys
import threading

scope = sys.argv[1] if len(sys.argv) > 1 else "share"
capacity_mode = sys.argv[2] if len(sys.argv) > 2 else "target"
target = base64.b64decode(sys.argv[3]).decode("utf-8") if len(sys.argv) > 3 else "/"
library_id = sys.argv[4] if len(sys.argv) > 4 else ""


def server_command():
    if scope == "system":
        candidates = ["/usr/local/bin/rclone", "/usr/bin/rclone"]
        rclone = shutil.which("rclone")
        if rclone:
            candidates.append(rclone)
        for candidate in candidates:
            if os.path.isabs(candidate) and os.access(candidate, os.X_OK):
                return [candidate, "serve", "sftp", "/", "--stdio",
                        "--config", "/dev/null", "--log-level", "ERROR"]
        return None
    # Preserve the NAS's merged shared/personal-folder SFTP view. The forced
    # command normally wraps every SSH command; invoking it with the SFTP
    # subsystem request reproduces that view instead of exposing the Linux root.
    for candidate in ("/etc/ssh/force_command.sh", "/usr/lib/openssh/sftp-server"):
        if os.path.isabs(candidate) and os.access(candidate, os.X_OK):
            return [candidate]
    return None


command = server_command()
if not command:
    sys.stderr.write("TAK_SFTP_SERVER_MISSING\n")
    sys.exit(127)

server_env = None
if scope != "system":
    server_env = os.environ.copy()
    server_env["SSH_ORIGINAL_COMMAND"] = "internal-sftp"
    server_env.setdefault("SHELL", "/bin/bash")
    server_env.setdefault("PATH", "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin")
    try:
        account = pwd.getpwuid(os.getuid()).pw_name
        server_env.setdefault("USER", account)
        server_env.setdefault("LOGNAME", account)
    except KeyError:
        pass
try:
    server = subprocess.Popen(command, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                              stderr=sys.stderr, bufsize=0, env=server_env)
except OSError as error:
    sys.stderr.write("TAK_SFTP_SERVER_START_FAILED: %s\n" % error)
    sys.exit(127)

output_lock = threading.Lock()
max_packet = 32 * 1024 * 1024


def read_exact(stream, size):
    chunks = []
    while size:
        chunk = stream.read(size)
        if not chunk:
            return None
        chunks.append(chunk)
        size -= len(chunk)
    return b"".join(chunks)


def read_packet(stream):
    header = read_exact(stream, 4)
    if header is None:
        return None
    size = struct.unpack(">I", header)[0]
    if size < 1 or size > max_packet:
        raise ValueError("invalid SFTP packet length")
    return read_exact(stream, size)


def write_all(stream, data):
    while data:
        written = stream.write(data)
        if written is None or written <= 0:
            raise BrokenPipeError()
        data = data[written:]
    stream.flush()


def send_client(packet):
    with output_lock:
        write_all(sys.stdout.buffer, struct.pack(">I", len(packet)) + packet)


def relay_server():
    try:
        while True:
            packet = read_packet(server.stdout)
            if packet is None:
                return
            send_client(packet)
    except (OSError, ValueError):
        return


def statvfs_request(packet):
    if len(packet) < 9 or packet[0] != 200:
        return False
    size = struct.unpack_from(">I", packet, 5)[0]
    return size == 19 and packet[9:9 + size] == b"statvfs@openssh.com"


REAL_FILESYSTEMS = {
    "ext2", "ext3", "ext4", "xfs", "btrfs", "f2fs", "ntfs", "fuseblk", "zfs",
}


def volume_values():
    """Sum the NAS data volumes exposed below the mount root."""
    mounts = []
    try:
        with open("/proc/mounts", "r", encoding="utf-8") as source:
            for line in source:
                fields = line.split()
                if len(fields) < 3 or fields[2] not in REAL_FILESYSTEMS:
                    continue
                mountpoint = fields[1].replace("\\040", " ")
                mounts.append(mountpoint)
    except OSError:
        return []
    preferred = [item for item in mounts if re.match(r"^/volume[0-9]+(/|$)", item)]
    candidates = preferred or [item for item in mounts if item != "/"]
    seen = set()
    total = free = 0
    for mountpoint in candidates:
        try:
            device = os.stat(mountpoint).st_dev
            if device in seen:
                continue
            info = os.statvfs(mountpoint)
        except OSError:
            continue
        seen.add(device)
        total += info.f_blocks * info.f_frsize
        free += info.f_bavail * info.f_frsize
    if total <= 0:
        return []
    return total, free


def data_volume_mounts():
    mounts = []
    try:
        with open("/proc/mounts", "r", encoding="utf-8") as source:
            for line in source:
                fields = line.split()
                if len(fields) < 3 or fields[2] not in REAL_FILESYSTEMS:
                    continue
                mountpoint = fields[1].replace("\\040", " ")
                mounts.append(mountpoint)
    except OSError:
        return []
    preferred = [item for item in mounts if re.match(r"^/volume[0-9]+(/|$)", item)]
    return preferred or [item for item in mounts if item != "/"]


def library_target():
    """Resolve the merged SFTP library path to its real data-volume path."""
    def marker_matches(path):
        try:
            with open(os.path.join(path, ".runtime", "library-id"), "r", encoding="utf-8") as source:
                return source.read().strip() == library_id
        except OSError:
            return False

    if os.path.exists(target) and (not library_id or marker_matches(target)):
        return target
    relative = target.lstrip("/")
    matches = []
    fallback = []
    for volume in data_volume_mounts():
        candidate = os.path.join(volume, relative)
        if os.path.isfile(os.path.join(candidate, "library.json")):
            fallback.append(candidate)
            if not library_id or marker_matches(candidate):
                matches.append(candidate)
    if len(matches) == 1:
        return matches[0]
    if not library_id and len(fallback) == 1:
        return fallback[0]
    return target


def filesystem_values():
    if capacity_mode == "all":
        aggregate = volume_values()
        if aggregate:
            total, free = aggregate
            block = 4096
            return (block, block, total // block, free // block, free // block,
                    0, 0, 0, 0, 0, 255)
    path = library_target() if capacity_mode == "library" else target
    info = os.statvfs(path)
    return (info.f_bsize, info.f_frsize, info.f_blocks, info.f_bfree,
            info.f_bavail, info.f_files, info.f_ffree, info.f_favail,
            getattr(info, "f_fsid", 0), info.f_flag & 3, info.f_namemax)


def filesystem_reply(packet):
    request_id = struct.unpack_from(">I", packet, 1)[0]
    try:
        values = filesystem_values()
        return struct.pack(">BI11Q", 201, request_id, *values)
    except OSError:
        message = b"filesystem capacity unavailable"
        return (struct.pack(">BII", 101, request_id, 4) +
                struct.pack(">I", len(message)) + message + struct.pack(">I", 0))


thread = threading.Thread(target=relay_server, daemon=True)
thread.start()
try:
    while True:
        packet = read_packet(sys.stdin.buffer)
        if packet is None:
            break
        if statvfs_request(packet):
            send_client(filesystem_reply(packet))
            continue
        write_all(server.stdin, struct.pack(">I", len(packet)) + packet)
except (OSError, ValueError):
    pass
finally:
    try:
        server.stdin.close()
    except OSError:
        pass
    thread.join(timeout=3)
    if server.poll() is None:
        server.terminate()
    try:
        server.wait(timeout=3)
    except subprocess.TimeoutExpired:
        server.kill()
