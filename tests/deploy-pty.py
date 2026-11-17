"""QA only: exercise the actual terminal renderer and a real terminal Ctrl+C."""
import errno
import fcntl
import os
import pty
import select
import signal
import struct
import sys
import termios
import time

if os.environ.get("BRLIFT_DEPLOY_QA") != "1" or sys.platform != "linux":
    raise SystemExit("Use npm run test:deploy (container descartavel).")

mode = sys.argv[1]
rows, cols = (12, 50) if mode == "small" else (24, 90)
pid, fd = pty.fork()
if pid == 0:
    os.environ["TERM"] = "dumb" if mode == "dumb" else "xterm-256color"
    os.execv("/usr/local/bin/brlift-deploy", ["brlift-deploy"])

fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))
output = bytearray()
status = None
interrupted = False
resized = False
deadline = time.monotonic() + 18
while time.monotonic() < deadline:
    ready, _, _ = select.select([fd], [], [], 0.05)
    if ready:
        try:
            chunk = os.read(fd, 65536)
        except OSError as error:
            if error.errno == errno.EIO:
                break
            raise
        if not chunk:
            break
        output.extend(chunk)
        if mode == "interrupt" and not interrupted and b"[....] Build: backend" in output:
            os.write(fd, b"\x03")
            interrupted = True
        if mode == "resize" and not resized and b"[....] Build: backend" in output:
            output.extend(b"\nQA_RESIZE\n")
            fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", 12, 50, 0, 0))
            resized = True
    if status is None:
        ended, ended_status = os.waitpid(pid, os.WNOHANG)
        if ended:
            status = ended_status
            # Continue draining the PTY until EIO/EOF.

if status is None:
    ended, ended_status = os.waitpid(pid, os.WNOHANG)
    if ended:
        status = ended_status
    else:
        os.kill(pid, signal.SIGTERM)  # the viewer only; never the detached worker
        _, status = os.waitpid(pid, 0)
os.close(fd)
sys.stdout.buffer.write(output)
code = os.waitstatus_to_exitcode(status)
raise SystemExit(code if code >= 0 else 128 - code)
