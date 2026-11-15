import base64
import os
import re
import shutil
import struct
import subprocess
import sys
import threading

mode = sys.argv[1] if len(sys.argv) > 1 else "target"
target = base64.b64decode(sys.argv[2]).decode("utf-8")


def server_command():
    # rclone's SFTP server is already required by the full-filesystem mode and
    # also works for a normal SSH account. Prefer it because distro sftp-server
    # wrappers are not consistently startable outside sshd.
    candidates = ["/usr/local/bin/rclone", "/usr/bin/rclone"]
    rclone = shutil.which("rclone")
    if rclone:
        candidates.append(rclone)
    for candidate in candidates:
        if os.path.isabs(candidate) and os.access(candidate, os.X_OK):
            return [candidate, "serve", "sftp", "/", "--stdio",
                    "--config", "/dev/null", "--log-level", "ERROR"]
    for candidate in ("/usr/lib/openssh/sftp-server", "/usr/libexec/openssh/sftp-server",
                      "/usr/libexec/sftp-server", "/usr/lib/ssh/sftp-server",
                      "/usr/bin/sftp-server"):
        if os.path.isabs(candidate) and os.access(candidate, os.X_OK):
            return [candidate]
    return None


command = server_command()
if not command:
    sys.stderr.write("TAK_SFTP_SERVER_MISSING\n")
    sys.exit(127)

server = subprocess.Popen(command, stdin=subprocess.PIPE, stdout=subprocess.PIPE, bufsize=0)
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
    """Sum the NAS data volumes exposed below the mount root.

    Explorer sees the whole server because the drive mounts "/", so its capacity
    must be the sum of the real data volumes (volume1 + volume2), not the
    overlay/system root. Bind mounts and subvolumes share st_dev and are counted
    once.
    """
    mounts = []
    try:
        with open("/proc/mounts", "r", encoding="utf-8") as source:
            for line in source:
                fields = line.split()
                if len(fields) < 3 or fields[2] not in REAL_FILESYSTEMS:
                    continue
                mountpoint = fields[1].replace("\040", " ")
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


def filesystem_values():
    if mode == "all":
        aggregate = volume_values()
        if aggregate:
            total, free = aggregate
            block = 4096
            return (block, block, total // block, free // block, free // block,
                    0, 0, 0, 0, 0, 255)
    info = os.statvfs(target)
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
