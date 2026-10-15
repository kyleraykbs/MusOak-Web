"""The two real processes the suite drives: the MusOak server, and the web UI's
own server in front of it.

Nothing here is a stub. A test that passes against a fake server proves the fake
server works; these are the binaries a person runs, with a temporary storage
directory, an ephemeral port and every provider switched off so no test touches
the network.

The binaries are resolved in one order and the resolved path is printed in the
report, because a suite that silently tests yesterday's build is worse than one
that fails:

    --musoakd / $MUSOAKD / ../musoak/result/bin/musoakd / go build ../musoak
"""

from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request

SIBLING = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


class StartupError(RuntimeError):
    """A process that a test needs did not come up."""


def _first_existing(candidates):
    for path, why in candidates:
        if not path:
            continue
        if os.path.isfile(path) and os.access(path, os.X_OK):
            return path, why
    return None, None


def _go_build(module_dir, package, out_path):
    """Build a binary from a sibling checkout, when a Go toolchain is here.

    The last resort that still tests the code on this disk rather than a
    published build: a checkout with a Go toolchain is the normal state of the
    two repositories side by side.
    """
    if not os.path.isdir(module_dir) or shutil.which("go") is None:
        return None
    try:
        subprocess.run(
            ["go", "build", "-o", out_path, package],
            cwd=module_dir,
            check=True,
            capture_output=True,
            timeout=600,
        )
    except (subprocess.CalledProcessError, subprocess.TimeoutExpired):
        return None
    return out_path if os.path.isfile(out_path) else None


def resolve_musoakd(explicit, work_dir):
    if explicit:
        return explicit, "--musoakd"
    root = os.path.join(SIBLING, "musoak")
    if os.environ.get("MUSOAKD"):
        return os.environ["MUSOAKD"], "$MUSOAKD"
    # The sibling checkout is built before any `result` symlink is trusted: a
    # result directory is a build from whenever somebody last ran nix build, and
    # a suite that quietly tests a week-old binary is worse than one that fails.
    built = _go_build(root, "./cmd/musoakd", os.path.join(work_dir, "musoakd"))
    if built:
        return built, "go build ./cmd/musoakd in ../musoak"
    found, why = _first_existing([
        (os.path.join(root, "result", "bin", "musoakd"), "musoak/result/bin/musoakd (a cached build)"),
    ])
    if found:
        return found, why
    raise StartupError(
        "no musoakd to test against. Pass --musoakd PATH, set $MUSOAKD, build "
        "../musoak (nix build or go build ./cmd/musoakd), or put a Go toolchain "
        "on PATH so it can be built from the sibling checkout."
    )


def resolve_musoak_web(explicit, work_dir):
    if explicit:
        return explicit, "--musoak-web"
    repo = os.path.join(SIBLING, "musoak-web")
    if os.environ.get("MUSOAK_WEB"):
        return os.environ["MUSOAK_WEB"], "$MUSOAK_WEB"
    built = _go_build(repo, "./cmd/musoak-web", os.path.join(work_dir, "musoak-web"))
    if built:
        return built, "go build ./cmd/musoak-web in this checkout"
    found, why = _first_existing([
        (os.path.join(repo, "result", "bin", "musoak-web"), "musoak-web/result/bin/musoak-web (a cached build)"),
    ])
    if found:
        return found, why
    raise StartupError(
        "no musoak-web to test against. Pass --musoak-web PATH, set $MUSOAK_WEB, "
        "or put a Go toolchain on PATH so it can be built from this checkout."
    )


def identity(path):
    """What a binary is, so a run cannot be ambiguous about what it tested."""
    if not path or not os.path.exists(path):
        return f"{path} (missing)"
    stat = os.stat(path)
    stamp = time.strftime("%Y-%m-%dT%H:%M:%S", time.localtime(stat.st_mtime))
    return f"{path} ({stat.st_size} bytes, built {stamp})"


def checkout_head(repo):
    """The commit a checkout is on, and whether it has uncommitted changes."""
    try:
        head = subprocess.run(
            ["git", "-C", repo, "rev-parse", "--short", "HEAD"],
            capture_output=True, text=True, timeout=10, check=True,
        ).stdout.strip()
        dirty = subprocess.run(
            ["git", "-C", repo, "status", "--porcelain"],
            capture_output=True, text=True, timeout=10, check=True,
        ).stdout.strip()
    except (subprocess.CalledProcessError, subprocess.TimeoutExpired, FileNotFoundError):
        return "unknown"
    return head + (" + working changes" if dirty else "")


def free_port():
    """A port nothing is listening on, right now.

    The server's own config refuses port 0, so the harness picks: bind, read the
    port, let it go, and hand it over. There is a race, which is why every
    server here retries with a fresh port when the bind fails - a suite that
    fails once in fifty runs for an unrelated reason teaches people to ignore
    it.
    """
    import socket

    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
        probe.bind(("127.0.0.1", 0))
        return probe.getsockname()[1]


def _spawn_with_a_port(name, argv_for, log_path, work_dir, attempts=6):
    """Start a server on a free port, retrying if the port was taken."""
    last = None
    for _ in range(attempts):
        port = free_port()
        process = Process(name, argv_for(port), cwd=work_dir, log_path=log_path)
        try:
            found = process.wait_line(r'addr(?:ess)?=([0-9.]+:[0-9]+)', 30, "logged its listen address")
            return process, "http://" + found.group(1)
        except StartupError as error:
            last = error
            taken = "address already in use" in "\n".join(process.log()).lower()
            process.stop()
            if not taken:
                raise
    raise last


class Process:
    """A child process whose log a test can read and wait on."""

    def __init__(self, name, argv, cwd, log_path, env=None):
        self.name = name
        self.argv = argv
        self.log_path = log_path
        self._lines = []
        self._lock = threading.Lock()
        self._handle = open(log_path, "w", encoding="utf-8")
        self._handle.write("$ " + " ".join(argv) + "\n")
        self._handle.flush()
        child_env = dict(os.environ)
        child_env.update(env or {})
        self.proc = subprocess.Popen(
            argv,
            cwd=cwd,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            bufsize=1,
            env=child_env,
        )
        self._reader = threading.Thread(target=self._pump, daemon=True)
        self._reader.start()

    def _pump(self):
        for line in self.proc.stdout:
            with self._lock:
                self._lines.append(line.rstrip("\n"))
            self._handle.write(line)
            self._handle.flush()

    def log(self):
        with self._lock:
            return list(self._lines)

    def wait_line(self, pattern, timeout, what):
        """Wait for a line matching pattern, and return the match."""
        rx = re.compile(pattern)
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            for line in self.log():
                found = rx.search(line)
                if found:
                    return found
            if self.proc.poll() is not None:
                raise StartupError(
                    f"{self.name} exited with {self.proc.returncode} before {what}.\n"
                    + self.tail()
                )
            time.sleep(0.02)
        raise StartupError(f"{self.name} never {what} within {timeout}s.\n" + self.tail())

    def tail(self, lines=40):
        return "\n".join([f"--- {self.name} log ({self.log_path})"] + self.log()[-lines:])

    def stop(self):
        if self.proc.poll() is None:
            self.proc.send_signal(subprocess.signal.SIGTERM)
            try:
                self.proc.wait(timeout=10)
            except subprocess.TimeoutExpired:
                self.proc.kill()
                self.proc.wait(timeout=5)
        try:
            self._reader.join(timeout=2)
        except RuntimeError:
            pass
        self._handle.close()


def free_style_config(**overrides):
    """A server config for tests: ephemeral port, no providers, no surprises.

    Providers are off so nothing reaches YouTube or Spotify; local files are the
    library. The rate limits that guard provider quota and password hashing are
    off, because a suite that trips its own limiter is testing the limiter.
    """
    config = {
        "listen": "127.0.0.1:0",
        "requireLogin": False,
        "registrationOpen": True,
        "rateLimit": {"searchPerMinute": 0, "loginPerMinute": 0},
        "media": {"quotaMB": 0, "prefetchPlaylists": True},
        "providers": {
            "ytmusic": {"enabled": False},
            "youtube": {"enabled": False},
            "spotify": {"enabled": False},
        },
        "defaultProviderOrder": ["ytmusic", "spotify"],
        "listenTogether": {"skipThreshold": 2.0, "minVotersForSkip": 2, "voterFractionForSkip": 0.5},
    }
    for key, value in overrides.items():
        if isinstance(value, dict) and isinstance(config.get(key), dict):
            config[key] = {**config[key], **value}
        else:
            config[key] = value
    return config


def _maybe_json(content_type, payload):
    """Whatever came back: JSON when it says so, text otherwise.

    The server answers YAML at /api/v1/openapi.yaml and audio at a media path,
    so a client that insists on JSON turns a healthy server into a stack trace.
    """
    if not payload:
        return None
    if content_type and "json" not in content_type.lower():
        return payload.decode(errors="replace")
    try:
        return json.loads(payload)
    except json.JSONDecodeError:
        return payload.decode(errors="replace")


class Backend:
    """The MusOak server, on an ephemeral port."""

    def __init__(self, binary, work_dir, config=None):
        self.binary = binary
        self.work_dir = work_dir
        # Not `storage`: the binary the harness builds lands in the run
        # directory, and a directory may not be both a binary and a folder.
        self.storage_dir = os.path.join(work_dir, "data")
        os.makedirs(self.storage_dir, exist_ok=True)
        self.media_dir = os.path.join(work_dir, "media-in")
        os.makedirs(self.media_dir, exist_ok=True)
        self.config_path = os.path.join(work_dir, "musoakd.json")
        self._config = {"storageDir": self.storage_dir, **(config or {})}

        def spawn(port):
            self._config["listen"] = f"127.0.0.1:{port}"
            with open(self.config_path, "w", encoding="utf-8") as handle:
                json.dump(free_style_config(**self._config), handle, indent=2)
            return [binary, "--config", self.config_path]

        self.process, self.url = _spawn_with_a_port(
            "musoakd", spawn, os.path.join(work_dir, "musoakd.log"), work_dir
        )

    def stop(self):
        self.process.stop()

    # --- a tiny REST client, for the facts a test should not scrape ---------

    def request(self, method, path, body=None, token=None, headers=None):
        data = None if body is None else json.dumps(body).encode()
        request = urllib.request.Request(self.url + path, data=data, method=method)
        request.add_header("Content-Type", "application/json")
        if token:
            request.add_header("Authorization", "Bearer " + token)
        for name, value in (headers or {}).items():
            request.add_header(name, value)
        try:
            with urllib.request.urlopen(request, timeout=30) as response:
                payload = response.read()
                return response.status, _maybe_json(response.headers.get("Content-Type"), payload)
        except urllib.error.HTTPError as error:
            payload = error.read()
            return error.code, _maybe_json(error.headers.get("Content-Type"), payload)

    def get(self, path, token=None):
        return self.request("GET", path, token=token)

    def post(self, path, body=None, token=None):
        return self.request("POST", path, body=body, token=token)

    def wait_ready(self, timeout=30):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            try:
                status, _ = self.get("/api/v1/openapi.yaml")
                if status == 200:
                    return
            except OSError:
                pass
            time.sleep(0.05)
        raise StartupError("musoakd never answered /api/v1/openapi.yaml.\n" + self.process.tail())

    def register(self, username, password="correct horse battery"):
        status, payload = self.post("/api/v1/auth/register", {"username": username, "password": password})
        if status != 200 or not payload or not payload.get("token"):
            raise StartupError(f"register {username} -> {status} {payload}")
        return payload["token"]


class Frontend:
    """The web UI's own server, in front of one backend."""

    def __init__(self, binary, work_dir, backend_url, web_dir):
        self.binary = binary
        self.web_dir = web_dir
        self.config_path = os.path.join(work_dir, "musoak-web.json")

        def spawn(port):
            config = {
                "listen": f"127.0.0.1:{port}",
                "defaultServer": backend_url,
                "servers": [{"name": "suite", "url": backend_url}],
                "allowCustomServer": True,
                "loginPopup": False,
                "blockPrivateServers": False,
            }
            with open(self.config_path, "w", encoding="utf-8") as handle:
                json.dump(config, handle, indent=2)
            argv = [binary, "--config", self.config_path]
            if web_dir:
                argv += ["--web-dir", web_dir]
            return argv

        self.process, self.url = _spawn_with_a_port(
            "musoak-web", spawn, os.path.join(work_dir, "musoak-web.log"), work_dir
        )

    def stop(self):
        self.process.stop()