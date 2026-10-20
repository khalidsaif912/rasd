"""يقرأ الحسابات التي لم يرها السيرفر، عبر اتصال المنزل، ثم يرسل الملخصات إليه."""

import json
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

import server

API = "https://rasd.158-220-106-38.sslip.io/api/state"
KEY = r"C:\Users\PC\.ssh\wa_sender_deploy"
HOST = "root@158.220.106.38"
WORK = Path.home() / "AppData" / "Local" / "Temp" / "rasd-home"
LOG = WORK / "reader.log"
SKIP = {"الحساب غير موجود"}
STALE = WORK / "last_read.json"
REFRESH_AFTER = 20 * 60

MERGE = r"""
import json, os, pwd
from pathlib import Path
live = Path("/opt/rasd/data/store.json")
incoming = json.loads(Path("/tmp/rasd-home.json").read_text(encoding="utf-8"))
names = {line.strip().lower() for line in Path("/tmp/rasd-home-users.txt").read_text(encoding="utf-8").splitlines() if line.strip()}
data = json.loads(live.read_text(encoding="utf-8"))
by_user = {account["username"].lower(): account for account in incoming["accounts"]}
for account in data["accounts"]:
    fresh = by_user.get(account["username"].lower())
    if account["username"].lower() in names and fresh:
        liked_ids = {post["id"] for post in data["posts"] if post.get("liked")}
        account.update({key: fresh.get(key) for key in ("name", "verified", "status", "updatedAt")})
        account["syncing"] = False
data_ids = {post["id"]: post for post in data["posts"]}
for post in incoming["posts"]:
    if post["username"].lower() not in names:
        continue
    previous = data_ids.get(post["id"])
    if previous and previous.get("liked"):
        post["liked"] = True
    if previous and (previous.get("points") or previous.get("summary") or previous.get("note")):
        if not (post.get("points") or post.get("summary") or post.get("note")):
            continue
    data["posts"] = [item for item in data["posts"] if item["id"] != post["id"]]
    data["posts"].append(post)
data["posts"].sort(key=lambda item: (item.get("username", ""), item.get("rank", 999)))
owner = pwd.getpwnam("rasd")
target = live.with_suffix(".json.tmp")
target.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
os.chown(target, owner.pw_uid, owner.pw_gid)
os.replace(target, live)
print("merged", len(names))
"""


def log(message):
    WORK.mkdir(parents=True, exist_ok=True)
    with LOG.open("a", encoding="utf-8") as handle:
        handle.write(time.strftime("%H:%M:%S ") + message + "\n")


def fetch_state():
    with urllib.request.urlopen(API, timeout=25) as response:
        return json.loads(response.read().decode("utf-8"))


def last_reads():
    if not STALE.exists():
        return {}
    try:
        return json.loads(STALE.read_text(encoding="utf-8-sig"))
    except json.JSONDecodeError:
        return {}


def pending(state):
    counts = {}
    for post in state["posts"]:
        key = post["username"].lower()
        counts[key] = counts.get(key, 0) + 1
    seen = last_reads()
    now = time.time()
    names = []
    for account in state["accounts"]:
        if account.get("syncing") or account.get("status") in SKIP:
            continue
        username = account["username"]
        empty = counts.get(username.lower(), 0) == 0
        age = now - seen.get(username.lower(), 0)
        needs_video = any(
            post["username"].lower() == username.lower() and not post.get("watched")
            for post in state["posts"]
        )
        if account.get("status") == "الحساب خاص" and empty and age < REFRESH_AFTER:
            continue
        if empty or needs_video or age >= REFRESH_AFTER:
            names.append(username)
    return names


def run(command):
    subprocess.run(command, check=True, capture_output=True)


def push(state, names):
    WORK.mkdir(parents=True, exist_ok=True)
    store = WORK / "store.json"
    users = WORK / "users.txt"
    merge = WORK / "merge.py"
    store.write_text(json.dumps(state, ensure_ascii=False, indent=2), encoding="utf-8")
    users.write_text("\n".join(names), encoding="utf-8")
    merge.write_text(MERGE, encoding="utf-8")
    remote = ["scp", "-i", KEY, "-o", "StrictHostKeyChecking=yes"]
    run(remote + [str(store), f"{HOST}:/tmp/rasd-home.json"])
    run(remote + [str(users), f"{HOST}:/tmp/rasd-home-users.txt"])
    run(remote + [str(merge), f"{HOST}:/tmp/rasd-home-merge.py"])
    run(["ssh", "-i", KEY, "-o", "StrictHostKeyChecking=yes", HOST, "sed -i 's/\\r$//' /tmp/rasd-home-merge.py; python3 /tmp/rasd-home-merge.py"])


def read_accounts(names):
    state = fetch_state()
    server.STORE_PATH = WORK / "store.json"
    WORK.mkdir(parents=True, exist_ok=True)
    server.STORE_PATH.write_text(json.dumps(state, ensure_ascii=False, indent=2), encoding="utf-8")
    from playwright.sync_api import sync_playwright

    with sync_playwright() as playwright:
        browser = server.launch_browser(playwright)
        try:
            seen = last_reads()
            for username in names:
                log("read " + username)
                server.sync_account(browser, username)
                updated = json.loads(server.STORE_PATH.read_text(encoding="utf-8"))
                push(updated, [username])
                seen[username.lower()] = time.time()
                STALE.write_text(json.dumps(seen), encoding="utf-8")
                log("pushed " + username)
        finally:
            browser.close()
    return json.loads(server.STORE_PATH.read_text(encoding="utf-8"))


def once():
    state = fetch_state()
    names = pending(state)
    if not names:
        return
    log("pending " + ",".join(names))
    read_accounts(names)


def main():
    log("start")
    while True:
        try:
            once()
        except Exception as exc:
            log("error " + str(exc))
        time.sleep(25)


if __name__ == "__main__":
    main()
