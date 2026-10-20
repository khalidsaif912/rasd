"""خادم رصد: يقرأ المنشورات الظاهرة لحساب عام ويلخص نصها."""

import json
import os
import re
import sys
import threading
import time
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
from pathlib import Path
from urllib.parse import parse_qs, urlparse

ROOT = Path(__file__).resolve().parent
STORE_PATH = ROOT / "data" / "store.json"
ALLOWED_ORIGIN = "https://khalidsaif912.github.io"
HOST = "127.0.0.1"
PORT = 8777

TIME_RE = re.compile(
    r"^(?:منذ\s+)?(?:"
    r"\d+\s*(?:د|س|أ|ي|ث|ساعة|ساعات|دقيقة|دقائق|يوم|أيام|أسبوع|أسابيع|hour|hours|minute|minutes|day|days|h|m|d)"
    r"|أسبوع(?:ين| واحد)?"
    r"|ساعة واحدة|ساعتين|يوم واحد|يومين|دقيقة واحدة|دقيقتين"
    r")$",
    re.IGNORECASE,
)
EASTERN_DIGITS = str.maketrans("٠١٢٣٤٥٦٧٨٩", "0123456789")
POINT_RE = re.compile(r"^(.+?)\s*\(([^)]+)\)\s*[:：]\s*(.+)$")
HANDLE_RE = re.compile(r"^[A-Za-z0-9._]{1,30}$")
BIDI_RE = re.compile(r"[\u200e\u200f\u202a-\u202e\u2066-\u2069]")

lock = threading.Lock()
jobs = []
jobs_guard = threading.Lock()
stop_event = threading.Event()


def clean_user(value):
    value = BIDI_RE.sub("", (value or "").strip())
    value = value.replace("@", "").strip().strip("/")
    if "instagram.com/" in value:
        value = value.split("instagram.com/", 1)[1].split("/")[0]
    value = value.split("?")[0].strip()
    return value if HANDLE_RE.fullmatch(value) else ""


def empty_store():
    return {
        "accounts": [
            {
                "username": "hiba.hamadeh.official",
                "name": "hiba.hamadeh.official",
                "verified": True,
                "status": "بانتظار القراءة",
                "syncing": False,
                "updatedAt": "",
            }
        ],
        "posts": [],
    }


def read_store():
    if not STORE_PATH.exists():
        data = empty_store()
        write_store(data)
        return data
    return json.loads(STORE_PATH.read_text(encoding="utf-8"))


def write_store(data):
    STORE_PATH.parent.mkdir(parents=True, exist_ok=True)
    STORE_PATH.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")


def update_account(username, **fields):
    if not fields.get("name"):
        fields.pop("name", None)
    with lock:
        data = read_store()
        for account in data["accounts"]:
            if account["username"].lower() == username.lower():
                account.update(fields)
                break
        write_store(data)


def is_time(line):
    return bool(TIME_RE.match(line.translate(EASTERN_DIGITS).strip()))


def extract_caption(text, username):
    lines = [BIDI_RE.sub("", line).strip() for line in text.splitlines()]
    lines = [line for line in lines if line]
    start = None
    when = ""
    for index, line in enumerate(lines):
        if line.lower() != username.lower():
            continue
        for follow in lines[index + 1:index + 7]:
            if is_time(follow):
                start = index + 1 + lines[index + 1:index + 7].index(follow) + 1
                when = follow
                break
        if start is not None:
            break
    if start is None:
        return when, ""
    caption = []
    position = start
    while position < len(lines):
        line = lines[position]
        nxt = lines[position + 1] if position + 1 < len(lines) else ""
        if line in {"أعجبني", "رد", "متابعة", "Meta", "ابدأ المحادثة.", "ابدأ المحادثة"}:
            break
        if line.startswith(("لا توجد تعليق", "قم بتسجيل", "المزيد من المنشورات", "عرض مزيد", "تسجيل إعجاب")):
            break
        if HANDLE_RE.fullmatch(line) and (is_time(nxt) or nxt.startswith("تسجيل إعجاب") or nxt in {"أعجبني", "رد"}):
            break
        caption.append(line)
        position += 1
    return when, "\n".join(caption).strip()


def summarize(caption):
    lines = [line.strip() for line in caption.splitlines() if line.strip()]
    points = []
    before = []
    after = []
    seen = False
    for line in lines:
        match = POINT_RE.match(line)
        if match:
            seen = True
            points.append({
                "name": match.group(1).strip(" :-"),
                "age": match.group(2).strip(),
                "advice": match.group(3).strip(),
            })
        elif seen:
            after.append(line)
        else:
            before.append(line)
    if points:
        title = " ".join(before).strip(" :") or "ملخص المنشور"
        subtitle = ""
        if " مع " in title:
            head, tail = title.split(" مع ", 1)
            title = head.strip()
            subtitle = "مع " + tail.strip(" :")
        return {
            "title": title,
            "subtitle": subtitle,
            "points": points,
            "summary": "",
            "note": " ".join(after).strip(),
        }
    if not lines:
        return {
            "title": "منشور بدون نص ظاهر",
            "subtitle": "",
            "points": [],
            "summary": "إنستغرام لم يظهر نصًا مع هذا المنشور.",
            "note": "",
        }
    title = lines[0].strip(" :")
    if len(title) > 90:
        title = title[:90].rsplit(" ", 1)[0] + "…"
    return {
        "title": title,
        "subtitle": "",
        "points": [],
        "summary": "\n".join(lines),
        "note": "",
    }


def enqueue(username):
    username = clean_user(username)
    if not username:
        return
    with jobs_guard:
        if username.lower() not in [item.lower() for item in jobs]:
            jobs.append(username)


def take_job():
    with jobs_guard:
        if not jobs:
            return None
        return jobs.pop(0)


def dismiss(page):
    for label in ("Close", "إغلاق"):
        button = page.locator(f"[aria-label='{label}']")
        try:
            if button.count():
                button.first.click(timeout=1000)
                page.wait_for_timeout(300)
        except Exception:
            pass


def profile_links(page, username):
    page.goto(f"https://www.instagram.com/{username}/", wait_until="domcontentloaded", timeout=45000)
    page.wait_for_timeout(2500)
    dismiss(page)
    links = page.eval_on_selector_all(
        "a[href*='/reel/'], a[href*='/p/']",
        """els => [...new Set(els.map(e => e.getAttribute('href')).filter(Boolean))]""",
    )
    title = BIDI_RE.sub("", page.title())
    verified = page.locator("[aria-label='Verified'], [aria-label='موثّق']").count() > 0
    body = page.inner_text("body")
    return links, title, verified, body


def shortcode_from(href):
    match = re.search(r"/(?:reel|p)/([^/?#]+)", href or "")
    return match.group(1) if match else ""


def read_post(page, username, href):
    code = shortcode_from(href)
    if not code:
        return None
    kind = "reel" if "/reel/" in href else "p"
    page.goto(f"https://www.instagram.com/{kind}/{code}/", wait_until="domcontentloaded", timeout=45000)
    try:
        page.wait_for_function(
            """() => /\\d+\\s*(س|د|ساعة|دقيقة|يوم)/.test(document.body.innerText)""",
            timeout=12000,
        )
    except Exception:
        page.wait_for_timeout(1500)
    dismiss(page)
    when, caption = extract_caption(page.inner_text("body"), username)
    summary = summarize(caption)
    return {
        "id": code,
        "username": username,
        "url": f"https://www.instagram.com/{kind}/{code}/",
        "when": when or "بتوقيت غير ظاهر",
        "kind": "ريل" if kind == "reel" else "منشور",
        "unread": True,
        "settled": bool(when),
        **summary,
    }


def sync_account(browser, username):
    update_account(username, syncing=True, status="يقرأ الحساب")
    page = browser.new_page(locale="ar", viewport={"width": 1280, "height": 900})
    try:
        links, title, verified, body = profile_links(page, username)
        name = ""
        if "(@" in title:
            name = title.split("(@", 1)[0].strip(" -•")
        if "Sorry" in body or "الصفحة غير متاحة" in body or "غير متوفرة" in body:
            update_account(username, syncing=False, status="الحساب غير موجود", name=name, verified=verified)
            return
        codes = []
        for href in links:
            code = shortcode_from(href)
            if code and code not in codes:
                codes.append(code)
        if not codes:
            private = "خاص" in body or "This account is private" in body
            with lock:
                has_posts = any(post["username"].lower() == username.lower() for post in read_store()["posts"])
            if private:
                status = "الحساب خاص"
            elif has_posts:
                status = "تعذر تحديث الصفحة، الملخصات السابقة محفوظة"
            else:
                status = "لم تظهر منشورات في الصفحة العامة"
            fields = {"syncing": False, "status": status, "verified": verified}
            if name:
                fields["name"] = name
            update_account(username, **fields)
            return
        with lock:
            known = {post["id"] for post in read_store()["posts"] if post.get("settled", True)}
        fresh = [href for href in links if shortcode_from(href) not in known]
        # Keep profile order, drop duplicate hrefs.
        seen = set()
        ordered = []
        for href in fresh:
            code = shortcode_from(href)
            if code and code not in seen:
                seen.add(code)
                ordered.append(href)
        total = len(ordered)
        def remember_order():
            with lock:
                data = read_store()
                rank = {code: index for index, code in enumerate(codes)}
                for item in data["posts"]:
                    if item["username"].lower() == username.lower() and item["id"] in rank:
                        item["rank"] = rank[item["id"]]
                data["posts"].sort(key=lambda item: item.get("rank", 999))
                write_store(data)

        if total == 0:
            remember_order()
            update_account(
                username,
                syncing=False,
                status="محدّث",
                name=name,
                verified=verified,
                updatedAt=time.strftime("%H:%M"),
            )
            return
        for index, href in enumerate(reversed(ordered), start=1):
            update_account(username, status=f"يلخص {index} من {total}", name=name, verified=verified)
            post = read_post(page, username, href)
            if not post:
                continue
            post["rank"] = codes.index(post["id"]) if post["id"] in codes else 999
            with lock:
                data = read_store()
                previous = next((item for item in data["posts"] if item["id"] == post["id"]), None)
                if previous and previous.get("liked"):
                    post["liked"] = True
                data["posts"] = [item for item in data["posts"] if item["id"] != post["id"]]
                data["posts"].append(post)
                rank = {code: index for index, code in enumerate(codes)}
                for item in data["posts"]:
                    if item["username"].lower() == username.lower() and item["id"] in rank:
                        item["rank"] = rank[item["id"]]
                data["posts"].sort(key=lambda item: item.get("rank", 999))
                write_store(data)
        update_account(
            username,
            syncing=False,
            status="محدّث",
            name=name,
            verified=verified,
            updatedAt=time.strftime("%H:%M"),
        )
    except Exception:
        update_account(username, syncing=False, status="تعذر قراءة الحساب، أعد المحاولة")
    finally:
        page.close()


def launch_browser(playwright):
    args = ["--disable-dev-shm-usage"]
    for channel in ("msedge", "chrome"):
        try:
            return playwright.chromium.launch(channel=channel, headless=True, args=args)
        except Exception:
            continue
    return playwright.chromium.launch(headless=True, args=args)


def worker():
    from playwright.sync_api import sync_playwright

    with sync_playwright() as playwright:
        browser = launch_browser(playwright)
        while not stop_event.is_set():
            username = take_job()
            if not username:
                time.sleep(1)
                continue
            try:
                if not browser.is_connected():
                    browser = launch_browser(playwright)
                sync_account(browser, username)
            except Exception:
                update_account(username, syncing=False, status="تعذر فتح المتصفح")
                try:
                    browser.close()
                except Exception:
                    pass
                browser = launch_browser(playwright)


def refresher():
    while not stop_event.is_set():
        time.sleep(480)
        if stop_event.is_set():
            break
        with lock:
            names = [account["username"] for account in read_store()["accounts"]]
        for name in names:
            enqueue(name)


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def log_message(self, fmt, *args):
        return

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        origin = self.headers.get("Origin")
        if origin == ALLOWED_ORIGIN:
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS")
            self.send_header("Access-Control-Allow-Headers", "Content-Type")
            self.send_header("Vary", "Origin")
        super().end_headers()

    def do_OPTIONS(self):
        self.send_response(204)
        self.end_headers()

    def send_json(self, payload, status=200):
        raw = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def read_json(self):
        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0:
            return {}
        return json.loads(self.rfile.read(length).decode("utf-8"))

    def do_GET(self):
        path = urlparse(self.path).path
        if path == "/api/state":
            with lock:
                self.send_json(read_store())
            return
        if path.startswith("/api/"):
            self.send_json({"error": "غير موجود"}, 404)
            return
        super().do_GET()

    def do_POST(self):
        path = urlparse(self.path).path
        try:
            body = self.read_json()
        except json.JSONDecodeError:
            self.send_json({"error": "طلب غير صالح"}, 400)
            return
        if path == "/api/accounts":
            username = clean_user(body.get("username", ""))
            if not username:
                self.send_json({"error": "اسم الحساب غير صالح"}, 400)
                return
            with lock:
                data = read_store()
                if not any(account["username"].lower() == username.lower() for account in data["accounts"]):
                    data["accounts"].append({
                        "username": username,
                        "name": username,
                        "verified": False,
                        "status": "بانتظار القراءة",
                        "syncing": True,
                        "updatedAt": "",
                    })
                    write_store(data)
            enqueue(username)
            self.send_json({"ok": True, "username": username})
            return
        if path == "/api/refresh":
            username = clean_user(body.get("username", ""))
            with lock:
                names = [account["username"] for account in read_store()["accounts"]]
            targets = [username] if username else names
            for name in targets:
                if name in names or name.lower() in [item.lower() for item in names]:
                    enqueue(name)
            self.send_json({"ok": True})
            return
        if path == "/api/like":
            post_id = str(body.get("id", ""))
            with lock:
                data = read_store()
                for post in data["posts"]:
                    if post["id"] == post_id:
                        post["liked"] = not post.get("liked", False) if body.get("toggle") else True
                write_store(data)
            self.send_json({"ok": True})
            return
        if path == "/api/seen":
            post_id = str(body.get("id", ""))
            with lock:
                data = read_store()
                for post in data["posts"]:
                    if post["id"] == post_id:
                        post["unread"] = not post.get("unread", True) if body.get("toggle") else False
                write_store(data)
            self.send_json({"ok": True})
            return
        self.send_json({"error": "غير موجود"}, 404)

    def do_DELETE(self):
        parsed = urlparse(self.path)
        query = parse_qs(parsed.query)
        if parsed.path == "/api/accounts":
            username = clean_user((query.get("username") or [""])[0])
            with lock:
                data = read_store()
                data["accounts"] = [account for account in data["accounts"] if account["username"].lower() != username.lower()]
                data["posts"] = [post for post in data["posts"] if post["username"].lower() != username.lower()]
                write_store(data)
            self.send_json({"ok": True})
            return
        if parsed.path == "/api/posts":
            post_id = (query.get("id") or [""])[0]
            with lock:
                data = read_store()
                data["posts"] = [post for post in data["posts"] if post["id"] != post_id]
                write_store(data)
            self.send_json({"ok": True})
            return
        self.send_json({"error": "غير موجود"}, 404)


def parse_command(raw):
    text = (raw or "").strip()
    action = "add"
    lowered = text.lower()
    if lowered.startswith("remove:"):
        action = "remove"
        text = text.split(":", 1)[1]
    elif lowered.startswith("account:"):
        text = text.split(":", 1)[1]
    return action, clean_user(text)


def prepare_issue():
    if os.environ.get("EVENT") != "issues":
        return
    action, username = parse_command(os.environ.get("TITLE", ""))
    if not username:
        print("ignored issue")
        return
    data = read_store()
    if action == "remove":
        data["accounts"] = [account for account in data["accounts"] if account["username"].lower() != username.lower()]
        data["posts"] = [post for post in data["posts"] if post["username"].lower() != username.lower()]
    elif not any(account["username"].lower() == username.lower() for account in data["accounts"]):
        data["accounts"].append(
            {
                "username": username,
                "name": username,
                "verified": False,
                "status": "بانتظار القراءة",
                "syncing": False,
                "updatedAt": "",
            }
        )
    write_store(data)
    print(f"{action} {username}")


def sync_once():
    data = read_store()
    names = [account["username"] for account in data["accounts"]]
    if not names:
        print("no accounts")
        return
    from playwright.sync_api import sync_playwright

    with sync_playwright() as playwright:
        browser = launch_browser(playwright)
        try:
            for username in names:
                sync_account(browser, username)
        finally:
            browser.close()


def main():
    if "--prepare" in sys.argv:
        prepare_issue()
        return
    if "--sync" in sys.argv:
        sync_once()
        return
    try:
        server = ThreadingHTTPServer((HOST, PORT), Handler)
    except OSError:
        print(f"http://{HOST}:{PORT} already running")
        return
    data = read_store()
    for account in data["accounts"]:
        enqueue(account["username"])
    threading.Thread(target=worker, daemon=True).start()
    threading.Thread(target=refresher, daemon=True).start()
    print(f"http://{HOST}:{PORT}")
    server.serve_forever()


if __name__ == "__main__":
    main()
