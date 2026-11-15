import base64
import os
import shutil
import struct
import subprocess
import sys
import threading

mode = sys.argv[1]
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


def filesystem_reply(packet):
    request_id = struct.unpack_from(">I", packet, 1)[0]
    try:
        info = os.statvfs(target)
        values = (info.f_bsize, info.f_frsize, info.f_blocks, info.f_bfree,
                  info.f_bavail, info.f_files, info.f_ffree, info.f_favail,
                  getattr(info, "f_fsid", 0), info.f_flag & 3, info.f_namemax)
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
