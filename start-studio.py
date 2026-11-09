#!/usr/bin/env python3
"""Starts PZ Skin Studio through a small helper on this computer, so it can save into its own folder.

Firefox can't write into a folder from a page, so opened straight from the file it saves paintings to
Downloads. Started this way, paintings go in "paint history" beside this script and imported skins
in "skins", in any browser. Chrome and Edge can already do that without it.

    python3 start-studio.py          (on Windows: py start-studio.py, or double-click it)

It opens the studio in your default browser and keeps running until you close this window or press
Ctrl+C. Only this computer can reach it, and it only reads this folder and only writes into
"skins" and "paint history". Needs Python 3.8 or newer, nothing else.

    python3 start-studio.py --app    opens it in a window of its own, the way the "PZ Skin Studio"
                                     program does, and stops when that window is closed
    python3 start-studio.py --install    adds PZ Skin Studio to the Linux applications menu
    python3 start-studio.py --uninstall  takes it out again
"""
import argparse
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import threading
import time
import urllib.request
import webbrowser
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlsplit

# A fixed port, because the browser keeps the studio's library per address: a new port each time
# would mean reading the models in again on every start.
PORT = 47819
PAGE = "PZSkinStudio.html"
WRITABLE = {"skins", "paint history"}
SKIP = {"node_modules", ".git", "paint history"}
MAX_UPLOAD = 64 * 1024 * 1024
SAFE_NAME = re.compile(r"^[^/\\:*?\"<>|\x00-\x1f]{1,120}\.(png|zip)$", re.IGNORECASE)
APP_NAME = "PZ Skin Studio"
WINDOW_CLASS = "PZSkinStudio"
ICON = Path("launcher") / "icon.png"
# The page checks in every 30 seconds while it's open (once a minute at worst when hidden), so a
# helper that can't watch its window stops after this long without hearing from it.
IDLE_SECONDS = 180
HANDED_OVER_SECONDS = 4

last_request = time.monotonic()


def make_handler(root: Path, port: int):
    hosts = {f"127.0.0.1:{port}", f"localhost:{port}"}

    class Handler(SimpleHTTPRequestHandler):
        # Browsers open spare connections they may never use; don't let one hold a thread forever.
        timeout = 30

        def __init__(self, *args, **kwargs):
            super().__init__(*args, directory=str(root), **kwargs)

        def log_message(self, *args):
            pass

        def parse_request(self):
            global last_request
            last_request = time.monotonic()
            return super().parse_request()

        # Another web page can't use the helper: a different Host means someone else's address
        # pointed here, and the X-Skin-Studio header can't be sent across sites without asking.
        def trusted(self, api: bool) -> bool:
            if self.headers.get("Host") not in hosts:
                return False
            return not api or self.headers.get("X-Skin-Studio") == "1"

        def reply(self, status, body: bytes, kind="application/json"):
            self.send_response(status)
            self.send_header("Content-Type", kind)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(body)

        def refuse(self, status=HTTPStatus.FORBIDDEN, why="Not allowed"):
            self.reply(status, why.encode(), "text/plain; charset=utf-8")

        def do_GET(self):
            path = unquote(urlsplit(self.path).path)
            if path.startswith("/api/"):
                if not self.trusted(api=True):
                    return self.refuse()
                if path == "/api/hello":
                    return self.reply(HTTPStatus.OK, json.dumps({"studio": True}).encode())
                if path == "/api/files":
                    return self.reply(HTTPStatus.OK, json.dumps({"name": root.name, "files": list_files(root)}).encode())
                return self.refuse(HTTPStatus.NOT_FOUND, "No such thing")
            if not self.trusted(api=False):
                return self.refuse()
            if path == "/favicon.ico":
                # The studio's own icon, which also becomes the app window's icon.
                icon = root / ICON
                return self.reply(HTTPStatus.OK, icon.read_bytes(), "image/png") if icon.is_file() \
                    else self.reply(HTTPStatus.NO_CONTENT, b"", "image/x-icon")
            if path == "/":
                self.send_response(HTTPStatus.FOUND)
                self.send_header("Location", f"/{PAGE}")
                self.end_headers()
                return
            parts = [p for p in path.split("/") if p]
            if any(p.startswith(".") for p in parts):
                return self.refuse(HTTPStatus.NOT_FOUND, "No such file")
            return super().do_GET()

        def do_HEAD(self):
            return self.refuse(HTTPStatus.METHOD_NOT_ALLOWED, "Not here")

        def do_POST(self):
            url = urlsplit(self.path)
            if url.path != "/api/save" or not self.trusted(api=True):
                return self.refuse()
            query = parse_qs(url.query)
            folder = query.get("folder", [""])[0]
            name = query.get("name", [""])[0].strip()
            if folder not in WRITABLE or not SAFE_NAME.match(name) or name.startswith("."):
                return self.refuse(HTTPStatus.BAD_REQUEST, "That name or folder isn't allowed")
            length = int(self.headers.get("Content-Length") or 0)
            if length <= 0 or length > MAX_UPLOAD:
                return self.refuse(HTTPStatus.BAD_REQUEST, "Nothing to save, or too big")
            data = self.rfile.read(length)
            try:
                saved = save_new(root / folder, name, data)
            except OSError as error:
                return self.refuse(HTTPStatus.INTERNAL_SERVER_ERROR, f"Could not save: {error.strerror or error}")
            return self.reply(HTTPStatus.OK, json.dumps({"name": saved}).encode())

    return Handler


def list_files(root: Path):
    out = []
    for folder, dirs, files in os.walk(root):
        dirs[:] = [d for d in dirs if d not in SKIP and not d.startswith(".")]
        rel = Path(folder).relative_to(root)
        out.extend((rel / f).as_posix() for f in files if not f.startswith("."))
    return out


# Keeps what's already there: the same bytes are not written twice, and a different file with the
# same name gets " (2)", " (3)" and so on, the way the studio does it in Chrome.
def save_new(folder: Path, name: str, data: bytes) -> str:
    folder.mkdir(exist_ok=True)
    dot = name.index(".")
    stem, ext = name[:dot], name[dot:]
    n = 1
    while True:
        candidate = name if n == 1 else f"{stem} ({n}){ext}"
        target = folder / candidate
        try:
            with open(target, "xb") as out:
                out.write(data)
            return candidate
        except FileExistsError:
            if target.read_bytes() == data:
                return candidate
        n += 1


# ---- A window of its own -----------------------------------------------------------------------

def data_dir() -> Path:
    if sys.platform.startswith("win"):
        return Path(os.environ.get("LOCALAPPDATA", Path.home())) / "PZSkinStudio"
    if sys.platform == "darwin":
        return Path.home() / "Library" / "Application Support" / "PZSkinStudio"
    return Path(os.environ.get("XDG_DATA_HOME") or Path.home() / ".local" / "share") / "PZSkinStudio"


# Chrome, Edge, Chromium and Brave can open a page as an app: its own window, with no tabs or
# address bar. Firefox can't, so it's only used if there's none of those.
def find_browser():
    if sys.platform.startswith("win"):
        places = [os.environ.get(v, "") for v in ("PROGRAMFILES(X86)", "PROGRAMFILES", "LOCALAPPDATA")]
        found = [Path(p) / rel for rel in (r"Microsoft\Edge\Application\msedge.exe", r"Google\Chrome\Application\chrome.exe")
                 for p in places if p]
        app = next((str(f) for f in found if f.is_file()), None)
        firefox = next((str(Path(p) / r"Mozilla Firefox\firefox.exe") for p in places
                        if p and (Path(p) / r"Mozilla Firefox\firefox.exe").is_file()), None)
        return ("app", app) if app else ("firefox", firefox) if firefox else (None, None)
    if sys.platform == "darwin":
        for path in ("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
                     "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
                     "/Applications/Chromium.app/Contents/MacOS/Chromium"):
            if Path(path).is_file():
                return "app", path
        firefox = "/Applications/Firefox.app/Contents/MacOS/firefox"
        return ("firefox", firefox) if Path(firefox).is_file() else (None, None)
    for name in ("google-chrome", "google-chrome-stable", "chromium", "chromium-browser",
                 "microsoft-edge", "microsoft-edge-stable", "brave-browser"):
        if shutil.which(name):
            return "app", shutil.which(name)
    return ("firefox", shutil.which("firefox")) if shutil.which("firefox") else (None, None)


def open_window(url: str, root: Path, args) -> subprocess.Popen:
    kind, browser = ("app", args.browser) if args.browser else find_browser()
    # A profile of its own keeps the studio's library apart from your browsing, and one per studio
    # folder keeps two copies of the studio apart from each other.
    profile = args.profile or data_dir() / "browser" / hashlib.sha1(str(root).encode()).hexdigest()[:12]
    profile = Path(profile)
    profile.mkdir(parents=True, exist_ok=True)
    quiet = {"stdout": subprocess.DEVNULL, "stderr": subprocess.DEVNULL}
    if kind == "app":
        return subprocess.Popen([
            browser, f"--app={url}", f"--user-data-dir={profile}", f"--class={WINDOW_CLASS}",
            "--no-first-run", "--no-default-browser-check", "--password-store=basic",
            "--window-size=1440,900", *args.browser_arg,
        ], **quiet)
    if kind == "firefox":
        (profile / "firefox").mkdir(exist_ok=True)
        return subprocess.Popen([browser, "--new-instance", "--profile", str(profile / "firefox"), url], **quiet)
    webbrowser.open(url)
    return None


def tell(message: str, app: bool):
    print(message, file=sys.stderr)
    # Started from the program or the menu there's no terminal to read, so say it in a window.
    if app and sys.platform.startswith("linux") and shutil.which("zenity"):
        subprocess.run(["zenity", "--error", "--title", APP_NAME, "--text", message], check=False)


def is_studio(url_base: str) -> bool:
    try:
        request = urllib.request.Request(f"{url_base}/api/hello", headers={"X-Skin-Studio": "1"})
        with urllib.request.urlopen(request, timeout=3) as answer:
            return json.load(answer).get("studio") is True
    except (OSError, ValueError):
        return False


def run_app(server, url: str, root: Path, args):
    threading.Thread(target=server.serve_forever, daemon=True).start()
    began = time.monotonic()
    window = open_window(url, root, args)
    if window is not None:
        window.wait()
    # A browser that hands the window to one it already had open returns within a second or so, and
    # then only the page itself says when it's done.
    if window is None or time.monotonic() - began < HANDED_OVER_SECONDS:
        while time.monotonic() - last_request < args.idle:
            time.sleep(1)
    server.shutdown()
    server.server_close()


# ---- The applications menu (Linux) --------------------------------------------------------------

def menu_entry() -> Path:
    base = Path(os.environ.get("XDG_DATA_HOME") or Path.home() / ".local" / "share")
    return base / "applications" / "pz-skin-studio.desktop"


def install(root: Path):
    program = root / APP_NAME
    exec_line = f'"{program}"' if program.is_file() else f'python3 "{root / "start-studio.py"}" --app'
    entry = menu_entry()
    entry.parent.mkdir(parents=True, exist_ok=True)
    entry.write_text(f"""[Desktop Entry]
Type=Application
Name={APP_NAME}
Comment=Preview and paint Project Zomboid skins
Exec={exec_line}
Icon={root / ICON}
Terminal=false
Categories=Graphics;
StartupWMClass={WINDOW_CLASS}
""")
    print(f"Added {APP_NAME} to the applications menu ({entry}).")
    print("If the studio folder moves, run this again from the new place.")


def uninstall():
    entry = menu_entry()
    if entry.exists():
        entry.unlink()
        print(f"Took {APP_NAME} out of the applications menu.")
    else:
        print(f"{APP_NAME} wasn't in the applications menu.")


class Server(ThreadingHTTPServer):
    # Stopping doesn't wait for idle connections a browser left open.
    daemon_threads = True
    block_on_close = False


def main():
    parser = argparse.ArgumentParser(description="Start PZ Skin Studio so it can save into its own folder.")
    parser.add_argument("--port", type=int, default=PORT)
    parser.add_argument("--folder", type=Path, default=Path(__file__).resolve().parent, help=argparse.SUPPRESS)
    parser.add_argument("--no-browser", action="store_true", help="don't open a browser")
    parser.add_argument("--app", action="store_true", help="open in a window of its own, and stop when it's closed")
    parser.add_argument("--install", action="store_true", help="add PZ Skin Studio to the applications menu (Linux)")
    parser.add_argument("--uninstall", action="store_true", help="take it out of the applications menu")
    # For tests: which browser, which profile, extra browser flags, and how long to wait for the page.
    parser.add_argument("--browser", help=argparse.SUPPRESS)
    parser.add_argument("--profile", help=argparse.SUPPRESS)
    parser.add_argument("--browser-arg", action="append", default=[], help=argparse.SUPPRESS)
    parser.add_argument("--idle", type=float, default=IDLE_SECONDS, help=argparse.SUPPRESS)
    args = parser.parse_args()
    root = args.folder.resolve()
    if args.install:
        return install(root)
    if args.uninstall:
        return uninstall()
    base = f"http://127.0.0.1:{args.port}"
    url = f"{base}/{PAGE}"
    if not (root / PAGE).is_file():
        tell(f"{PAGE} isn't in {root}. Keep {APP_NAME} in the studio folder, next to it.", args.app)
        sys.exit(1)
    try:
        server = Server(("127.0.0.1", args.port), make_handler(root, args.port))
    except OSError:
        if not is_studio(base):
            tell(f"Something else on this computer is using port {args.port}, so the studio can't start.", args.app)
            sys.exit(1)
        # Already running: just open another window on it.
        if args.app:
            open_window(url, root, args)
        elif not args.no_browser:
            print(f"The studio is already running. Opening {url}")
            webbrowser.open(url)
        return
    if args.app:
        return run_app(server, url, root, args)
    print(f"PZ Skin Studio is running at {url}")
    print("Paintings are saved in:", root / "paint history")
    print("Close this window or press Ctrl+C to stop it.")
    if not args.no_browser:
        threading.Timer(0.3, webbrowser.open, [url]).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
