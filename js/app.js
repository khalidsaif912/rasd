const PREFS_KEY = "rasd-prefs";
const SEEN_KEY = "rasd-seen-ids";
const eastern = ["٠", "١", "٢", "٣", "٤", "٥", "٦", "٧", "٨", "٩"];
const iconColors = ["blue", "green", "orange", "purple", "pink", "teal", "indigo"];
const API_ROOT = location.hostname.endsWith("github.io") ? "https://rasd.158-220-106-38.sslip.io/" : "";

function apiUrl(path) {
  return API_ROOT + path;
}

const titles = { summaries: "الملخصات", likes: "الإعجابات", accounts: "الحسابات", settings: "الإعدادات" };

let state = { accounts: [], posts: [] };
let filter = "all";
let query = "";
let view = "summaries";
let prefs = loadPrefs();
let timer = 0;
let apiAvailable = false;
let seenIds = loadSeen();
let arrivalsReady = localStorage.getItem(SEEN_KEY) !== null;

const feed = document.querySelector("#feed");
const likesFeed = document.querySelector("#likes-feed");
const likesCount = document.querySelector("#likes-count");
const accountList = document.querySelector("#account-list");
const filters = document.querySelector("#filters");
const accountCount = document.querySelector("#account-count");
const toast = document.querySelector("#toast");
const viewTitle = document.querySelector("#view-title");

function loadSeen() {
  try {
    const raw = JSON.parse(localStorage.getItem(SEEN_KEY) || "null");
    return new Set(Array.isArray(raw) ? raw : []);
  } catch (_) {
    return new Set();
  }
}

function saveSeen() {
  localStorage.setItem(SEEN_KEY, JSON.stringify([...seenIds]));
}

function arrivalPhrase(count) {
  if (count === 1) return "فيديو جديد";
  if (count === 2) return "فيديوهان جديدان";
  return "فيديوهات جديدة";
}

function updateArrival(count) {
  document.querySelectorAll("[data-badge]").forEach((badge) => {
    badge.hidden = count < 1;
    badge.textContent = toEastern(count);
  });
  const banner = document.querySelector("#arrival");
  if (!banner) return;
  banner.hidden = count < 1;
  document.querySelector("#arrival-count").textContent = toEastern(count);
  document.querySelector("#arrival-label").textContent = arrivalPhrase(count);
}

function noteArrivals() {
  const ids = state.posts.map((post) => post.id);
  if (!arrivalsReady) {
    ids.forEach((id) => seenIds.add(id));
    saveSeen();
    arrivalsReady = true;
    updateArrival(0);
    return;
  }
  updateArrival(ids.filter((id) => !seenIds.has(id)).length);
}

function dismissArrivals() {
  state.posts.forEach((post) => seenIds.add(post.id));
  saveSeen();
  updateArrival(0);
  showView("summaries");
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function loadPrefs() {
  try {
    return { dark: false, unreadOnly: false, compact: false, autoRefresh: true, ...JSON.parse(localStorage.getItem(PREFS_KEY) || "{}") };
  } catch (_) {
    return { dark: false, unreadOnly: false, compact: false, autoRefresh: true };
  }
}

function savePrefs() {
  localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
  applyPrefs();
}

function applyPrefs() {
  document.documentElement.classList.toggle("dark", !!prefs.dark);
  document.documentElement.classList.toggle("compact", !!prefs.compact);
  setSwitch("toggle-dark", prefs.dark);
  setSwitch("toggle-unread", prefs.unreadOnly);
  setSwitch("toggle-compact", prefs.compact);
  setSwitch("toggle-refresh", prefs.autoRefresh);
  schedule();
}

function setSwitch(id, on) {
  const button = document.getElementById(id);
  if (button) button.setAttribute("aria-checked", on ? "true" : "false");
}

function toEastern(n) {
  return String(n).replace(/\d/g, (d) => eastern[d]);
}

function esc(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function initials(username) {
  return username.replace(/[^a-z0-9]/gi, "").slice(0, 2).toUpperCase() || "ح";
}

function colorFor(username) {
  let sum = 0;
  for (const char of username) sum += char.charCodeAt(0);
  return iconColors[sum % iconColors.length];
}

function showToast(message) {
  toast.textContent = message;
  toast.classList.add("show");
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => toast.classList.remove("show"), 1800);
}

function plainText(post) {
  if (post.points && post.points.length) {
    const lines = [`${post.title}${post.subtitle ? " " + post.subtitle : ""}:`];
    post.points.forEach((point) => {
      const age = point.age ? ` (${point.age})` : "";
      lines.push(`${point.name}${age}: ${point.advice}`.trim());
    });
    if (post.note) lines.push("", post.note);
    return lines.join("\n");
  }
  return [post.title, post.summary].filter(Boolean).join("\n\n");
}

async function copyText(post) {
  const text = plainText(post);
  try {
    await navigator.clipboard.writeText(text);
  } catch (_) {
    const area = document.createElement("textarea");
    area.value = text;
    document.body.appendChild(area);
    area.select();
    document.execCommand("copy");
    area.remove();
  }
  showToast("تم نسخ الملخص");
}

function queryMatch(post) {
  const q = query.trim().toLowerCase();
  if (!q || (view !== "summaries" && view !== "likes")) return true;
  const blob = [
    post.title, post.subtitle, post.note, post.summary, post.username,
    ...(post.points || []).flatMap((point) => [point.name, point.age, point.advice]),
  ].join(" ").toLowerCase();
  return blob.includes(q);
}

function visiblePosts() {
  return state.posts.filter((post) => {
    if (prefs.unreadOnly && !post.unread) return false;
    if (filter !== "all" && post.username !== filter) return false;
    return view !== "summaries" || queryMatch(post);
  });
}

const CONTENT_STOP = new Set("مع من في على علي كل ما مش هو هي هذا هذه عن الى الي او ثم كان كانت شو قبل بعد مره عم مين كيف الناس لازم بدي انا اللي الذي التي لا لم لن قد بين حتى عند بدون غير مثل متل بس لان هيدا هيدي يا بدنا فيه فيها ذلك شي شيء مو رح كمان فقط هنا هناك جدا ايضا اليوم يوم ايام ليل ليله ليلتين مع ان تم هم هن انت نحن دي دا ال ب ل و مرة بحياته مهمه سريعه نصيحه اختار شوف لازم بتمنى اكتر اكثر الكتب كتاب خمس خمسه اشياء شيء يكون تكون لقد هناك".split(/\s+/));

function normalizeWord(value) {
  return (value || "")
    .replace(/[\u064B-\u0652\u0640]/g, "")
    .replace(/[أإآ]/g, "ا")
    .replace(/ة/g, "ه")
    .replace(/ى/g, "ي")
    .toLowerCase();
}

function contentStem(raw) {
  let word = normalizeWord(raw).replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");
  if (!word || /^\d+$/.test(word)) return "";
  word = word.replace(/^(وال|بال|لل|عال|ال|و|ب|ل)/, "");
  word = word.replace(/(نا|ون|ين|ها|ه)$/, "");
  if (word.length < 3 || CONTENT_STOP.has(word)) return "";
  if (/^طفل|^اطفال/.test(word)) return "أطفال";
  if (word.includes("مدرس")) return "مدرسة";
  if (/تعلم|تعليم/.test(word)) return "تعليم";
  if (word.includes("انشط")) return "أنشطة";
  if (word.includes("لعب") || word.includes("العاب")) return "ألعاب";
  if (word.includes("طالب")) return "طلاب";
  if (word.includes("والد") || word.includes("اهل")) return "تربية";
  if (/^[a-z]{1,2}$/.test(word)) return "";
  return word;
}

function contentPieces(post) {
  const bits = [post.title, post.subtitle, post.summary, post.note];
  (post.points || []).forEach((point) => bits.push(point.name, point.advice));
  return bits.filter(Boolean).join(" ");
}

function contentTopic(account) {
  const posts = state.posts.filter((post) => post.username === account.username);
  const blocked = new Set(
    `${account.name || ""} ${account.username || ""}`
      .split(/[^\p{L}\p{N}]+/u)
      .map(contentStem)
      .filter(Boolean)
  );
  const counts = new Map();
  posts.forEach((post) => {
    const seen = new Set();
    contentPieces(post).split(/[^\p{L}\p{N}]+/u).forEach((part) => {
      const stem = contentStem(part);
      if (!stem || blocked.has(stem) || seen.has(stem)) return;
      seen.add(stem);
      counts.set(stem, (counts.get(stem) || 0) + 1);
    });
  });
  const ranked = [...counts.entries()]
    .filter(([, count]) => count >= 2)
    .sort((a, b) => b[1] - a[1] || b[0].length - a[0].length)
    .map(([stem]) => stem);
  const labels = [...new Set(ranked)].slice(0, 4);
  if (labels.includes("تعليم") && labels.includes("أطفال")) return "تعليم الأطفال";
  if (labels.includes("مدرسة") && labels.includes("أطفال")) return "مدرسة الأطفال";
  if (labels.includes("أنشطة") && labels.includes("أطفال")) return "أنشطة للأطفال";
  if (labels.includes("ألعاب") && labels.includes("أطفال")) return "ألعاب للأطفال";
  if (labels.includes("طلاب") && labels.includes("مدرسة")) return "طلاب المدارس";
  if (labels.includes("أطفال")) {
    const other = labels.find((item) => item !== "أطفال");
    return other ? `${other} للأطفال` : "تربية الأطفال";
  }
  if (labels.length) return labels.slice(0, 3).join(" ");
  const newest = posts.find((post) => (post.title || "").trim());
  if (!newest) return "";
  const title = newest.title.replace(/[.\u2026]{2,}/g, " ").replace(/\s+/g, " ").trim();
  return title.length > 48 ? title.slice(0, 48).replace(/\s+\S*$/, "") : title;
}

function similarSearchUrl(account) {
  const topic = contentTopic(account);
  if (!topic) return "";
  return `https://www.instagram.com/explore/search/keyword/?q=${encodeURIComponent(topic)}`;
}

function renderAccounts() {
  const q = view === "accounts" ? query.trim().toLowerCase() : "";
  const accounts = state.accounts.filter((account) => {
    if (!q) return true;
    return `${account.name} ${account.username} ${account.status}`.toLowerCase().includes(q);
  });
  accountCount.textContent = toEastern(state.accounts.length);
  if (!accounts.length) {
    accountList.innerHTML = `<li class="row"><span class="row-copy"><strong>لا حسابات مطابقة</strong><small>أضف اسم حساب عام في الحقل أعلاه.</small></span></li>`;
    return;
  }
  accountList.innerHTML = accounts.map((account) => `
    <li>
      <div class="row account-row">
        <button class="account-open" type="button" data-open-account="${esc(account.username)}">
          <span class="sq ${colorFor(account.username)}" aria-hidden="true">${esc(initials(account.username))}</span>
          <span class="row-copy">
            <strong>${esc(account.name || account.username)}</strong>
            <small class="handle">${esc(account.username)}</small>
            <small class="status ${account.syncing ? "busy" : ""}">${esc(account.status || "")}</small>
          </span>
          <svg class="chevron" viewBox="0 0 12 20" aria-hidden="true"><path d="M10 2 2 10l8 8" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
        </button>
        <div class="account-actions">
          ${similarSearchUrl(account)
            ? `<a class="similar" href="${similarSearchUrl(account)}" target="_blank" rel="noopener" title="بحث عن حسابات بنفس المحتوى: ${esc(contentTopic(account))}" aria-label="بحث عن حسابات بنفس المحتوى: ${esc(contentTopic(account))}">
            <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.2" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M15.2 15.2 20 20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>
            <span>${esc(contentTopic(account))}</span>
          </a>`
            : `<span class="similar is-disabled" title="لا يوجد محتوى بعد">شبيهة</span>`}
          <button class="remove" type="button" data-remove-account="${esc(account.username)}">إزالة</button>
        </div>
      </div>
    </li>
  `).join("");

  const chips = [`<button class="chip ${filter === "all" ? "active" : ""}" data-filter="all" type="button">الكل</button>`]
    .concat(state.accounts.map((account) =>
      `<button class="chip ${filter === account.username ? "active" : ""}" data-filter="${esc(account.username)}" type="button">${esc(account.username)}</button>`
    ));
  filters.innerHTML = chips.join("");
}

function postCard(post) {
  const account = state.accounts.find((item) => item.username === post.username);
  const points = (post.points || []).map((point, index) => `
    <li>
      <span class="index">${toEastern(index + 1)}</span>
      <div>
        <strong>${esc(point.name)}</strong>
        ${point.advice ? `<p>${esc(point.advice)}</p>` : ""}
      </div>
      ${point.age ? `<span class="age" dir="ltr">${esc(point.age)}</span>` : ""}
    </li>
  `).join("");
  const body = points
    ? `<ol class="points">${points}</ol>`
    : `<p class="summary">${esc(post.summary || "")}</p>`;
  return `
    <article class="card ${post.unread ? "unread" : ""} ${post.liked ? "liked" : ""}">
      <div class="meta">
        <span class="avatar sq ${colorFor(post.username)}">${esc(initials(post.username))}</span>
        <span>
          <strong dir="ltr">${esc(post.username)}</strong>
          ${account && account.verified ? '<span class="verified" title="موثّق">✓</span>' : ""}
          <span class="handle">${esc(post.when || "")} · ${esc(post.kind || "منشور")}</span>
        </span>
      </div>
      <h3>${esc(post.title || "")}</h3>
      ${post.subtitle ? `<p class="subtitle">${esc(post.subtitle)}</p>` : ""}
      ${body}
      ${post.note ? `<div class="note">${esc(post.note)}</div>` : ""}
      <div class="ig-actions" role="group" aria-label="إجراءات المنشور">
        <button class="ig-btn like ${post.liked ? "on" : ""}" type="button" data-like="${esc(post.id)}" aria-pressed="${post.liked ? "true" : "false"}" aria-label="${post.liked ? "إزالة الإعجاب" : "إعجاب"}" title="إعجاب">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 20.2s-6.8-4.2-6.8-9.1A3.9 3.9 0 0 1 12 8.2a3.9 3.9 0 0 1 6.8 2.9c0 4.9-6.8 9.1-6.8 9.1z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/></svg>
        </button>
        <button class="ig-btn" type="button" data-copy="${esc(post.id)}" aria-label="نسخ النص" title="نسخ">
          <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="8" y="8" width="11" height="11" rx="2" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M6 15.5H5.2A1.8 1.8 0 0 1 3.4 13.7V5.2A1.8 1.8 0 0 1 5.2 3.4h8.5a1.8 1.8 0 0 1 1.8 1.8V6" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/></svg>
        </button>
        <a class="ig-btn" href="${esc(post.url)}" target="_blank" rel="noopener" aria-label="فتح المنشور" title="فتح المنشور">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 5h5v5M19 5l-9 9" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/><path d="M18 13.5V19a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5.5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>
        </a>
        <button class="ig-btn" type="button" data-read="${esc(post.id)}" aria-label="${post.unread ? "تعليم كمقروء" : "مقروء"}" title="${post.unread ? "تعليم كمقروء" : "مقروء"}">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5 9.2 16.5 19 7.5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>
        </button>
        <button class="ig-btn danger" type="button" data-delete="${esc(post.id)}" aria-label="حذف" title="حذف">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 7h14M9 7V5.2A1.2 1.2 0 0 1 10.2 4h3.6A1.2 1.2 0 0 1 15 5.2V7M8 7l.8 12.2A1.2 1.2 0 0 0 10 20.4h4a1.2 1.2 0 0 0 1.2-1.2L16 7" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>
        </button>
        <button class="ig-btn save ${post.liked ? "on" : ""}" type="button" data-like="${esc(post.id)}" aria-pressed="${post.liked ? "true" : "false"}" aria-label="${post.liked ? "إزالة الحفظ" : "حفظ"}" title="حفظ">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6.5 3.8h11a1.2 1.2 0 0 1 1.2 1.2V21L12 16.6 5.3 21V5a1.2 1.2 0 0 1 1.2-1.2z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/></svg>
        </button>
      </div>
    </article>
  `;
}

function renderFeed() {
  const syncing = state.accounts.some((account) => account.syncing);
  const posts = visiblePosts();
  if (!posts.length) {
    const message = syncing
      ? "يقرأ المنشورات الآن. أول ملخص يظهر بعد قليل."
      : "أضف حسابًا عامًا من قسم الحسابات.";
    feed.innerHTML = `<div class="empty">${message}</div>`;
    return;
  }
  feed.innerHTML = posts.map(postCard).join("");
}

function renderLikes() {
  const posts = state.posts.filter((post) => post.liked && queryMatch(post));
  if (likesCount) {
    const label = posts.length === 1 ? "ملخص واحد أعجبك" : posts.length === 2 ? "ملخصان أعجبك" : posts.length ? `${toEastern(posts.length)} ملخصات أعجبتك` : "الملخصات التي وضعت عليها إعجابًا.";
    likesCount.textContent = label;
  }
  if (!likesFeed) return;
  if (!posts.length) {
    likesFeed.innerHTML = `<div class="empty">لم تحفظ ملخصًا بعد. اضغط القلب أو علامة الحفظ.</div>`;
    return;
  }
  likesFeed.innerHTML = posts.map(postCard).join("");
}

function filterSettings() {
  const q = view === "settings" ? query.trim().toLowerCase() : "";
  document.querySelectorAll("#view-settings .group").forEach((group) => {
    let visible = 0;
    group.querySelectorAll(".row").forEach((row) => {
      const text = (row.dataset.search || row.innerText || "").toLowerCase();
      const hide = !!q && !text.includes(q);
      row.hidden = hide;
      if (!hide) visible += 1;
    });
    group.hidden = visible === 0;
  });
}

function render() {
  renderAccounts();
  renderFeed();
  renderLikes();
  filterSettings();
}

function narrowScreen() {
  return window.matchMedia("(max-width: 800px)").matches;
}

function setSidebar(open) {
  document.querySelector(".app").classList.toggle("sidebar-closed", !open);
  document.querySelector("#sidebar-toggle").setAttribute("aria-expanded", open ? "true" : "false");
  document.querySelector("#sidebar-scrim").hidden = !(open && narrowScreen());
}

function showView(next) {
  view = next;
  document.querySelectorAll("[data-nav]").forEach((button) => {
    button.classList.toggle("active", button.dataset.nav === next);
  });
  if (narrowScreen()) setSidebar(false);
  document.querySelector("#view-summaries").hidden = next !== "summaries";
  document.querySelector("#view-likes").hidden = next !== "likes";
  document.querySelector("#view-accounts").hidden = next !== "accounts";
  document.querySelector("#view-settings").hidden = next !== "settings";
  viewTitle.textContent = titles[next];
  filterSettings();
  if (next === "accounts") renderAccounts();
  if (next === "summaries") renderFeed();
  if (next === "likes") renderLikes();
}

function cleanUsername(value) {
  let text = String(value || "").trim().replace(/^@/, "");
  if (text.includes("instagram.com/")) text = text.split("instagram.com/")[1].split("/")[0];
  text = text.split("?")[0].trim();
  return /^[A-Za-z0-9._]{1,30}$/.test(text) ? text : "";
}

function applyLocalEdits() {
  if (apiAvailable) return;
  const hidden = new Set(JSON.parse(localStorage.getItem("rasd-hidden") || "[]"));
  const read = new Set(JSON.parse(localStorage.getItem("rasd-read") || "[]"));
  const likes = new Set(JSON.parse(localStorage.getItem("rasd-likes") || "[]"));
  state.posts = state.posts.filter((post) => !hidden.has(post.id));
  state.posts.forEach((post) => {
    if (read.has(post.id)) post.unread = false;
    if (likes.has(post.id)) post.liked = true;
  });
}

async function loadState() {
  let response = null;
  try {
    response = await fetch(apiUrl("api/state"), { cache: "no-store" });
  } catch (_) {
    response = null;
  }
  if (response && response.ok) {
    apiAvailable = true;
  } else {
    apiAvailable = false;
    response = await fetch(`data/store.json?t=${Date.now()}`, { cache: "no-store" });
  }
  if (!response.ok) throw new Error("state");
  state = await response.json();
  applyLocalEdits();
  if (filter !== "all" && !state.accounts.some((account) => account.username === filter)) filter = "all";
  noteArrivals();
  render();
  schedule();
}

function schedule() {
  clearInterval(timer);
  if (!prefs.autoRefresh) return;
  timer = setInterval(() => loadState().catch(() => {}), apiAvailable ? 4000 : 60000);
}

document.querySelectorAll("[data-nav]").forEach((button) => {
  button.addEventListener("click", () => showView(button.dataset.nav));
});

document.querySelector("#sidebar-toggle").addEventListener("click", () => {
  setSidebar(document.querySelector(".app").classList.contains("sidebar-closed"));
});
document.querySelector("#sidebar-scrim").addEventListener("click", () => setSidebar(false));
document.querySelector("#arrival").addEventListener("click", dismissArrivals);
setSidebar(!narrowScreen());

document.querySelector("#account-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const input = document.querySelector("#account-input");
  const button = document.querySelector("#add-account");
  const username = cleanUsername(input.value);
  if (!username) {
    showToast("اسم الحساب غير واضح");
    return;
  }
  if (!apiAvailable) {
    showToast("السيرفر غير متصل");
    return;
  }
  button.disabled = true;
  try {
    const response = await fetch(apiUrl("api/accounts"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username }),
    });
    const payload = await response.json();
    if (!response.ok) {
      showToast(payload.error || "تعذر إضافة الحساب");
      return;
    }
    input.value = "";
    showToast("بدأت قراءة الفيديوهات");
    await loadState();
  } catch (_) {
    showToast("الخادم غير متصل");
  } finally {
    button.disabled = false;
  }
});

async function refreshNow() {
  if (!apiAvailable) {
      showToast("الخادم يراجع الحسابات كل ثماني دقائق");
      loadState().catch(() => {});
      return;
    }
  await fetch(apiUrl("api/refresh"), { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
  showToast("بدأ التحديث");
  loadState();
}

document.querySelector("#refresh-all").addEventListener("click", refreshNow);
document.querySelector("#settings-refresh").addEventListener("click", refreshNow);

document.querySelector("#search").addEventListener("input", (event) => {
  query = event.target.value;
  render();
});

filters.addEventListener("click", (event) => {
  const button = event.target.closest("[data-filter]");
  if (!button) return;
  filter = button.dataset.filter;
  render();
});

accountList.addEventListener("click", async (event) => {
  const remove = event.target.closest("[data-remove-account]");
  const open = event.target.closest("[data-open-account]");
  if (remove) {
    if (!apiAvailable) {
      showToast("السيرفر غير متصل");
      return;
    }
    await fetch(apiUrl(`api/accounts?username=${encodeURIComponent(remove.dataset.removeAccount)}`), { method: "DELETE" });
    await loadState();
    return;
  }
  if (open) {
    filter = open.dataset.openAccount;
    showView("summaries");
    render();
  }
});

async function onFeedClick(event) {
  const copy = event.target.closest("[data-copy]");
  const read = event.target.closest("[data-read]");
  const remove = event.target.closest("[data-delete]");
  const like = event.target.closest("[data-like]");
  if (like) {
    const saved = like.classList.contains("save");
    const wasOn = like.getAttribute("aria-pressed") === "true";
    showToast(wasOn ? (saved ? "أُزيل الحفظ" : "أُزيل الإعجاب") : (saved ? "تم الحفظ" : "تم الإعجاب"));
    if (!apiAvailable) {
      const key = "rasd-likes";
      const ids = new Set(JSON.parse(localStorage.getItem(key) || "[]"));
      if (ids.has(like.dataset.like)) ids.delete(like.dataset.like);
      else ids.add(like.dataset.like);
      localStorage.setItem(key, JSON.stringify([...ids]));
      await loadState();
      return;
    }
    await fetch(apiUrl("api/like"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: like.dataset.like, toggle: true }),
    });
    await loadState();
    return;
  }
  if (copy) {
    const post = state.posts.find((item) => item.id === copy.dataset.copy);
    if (post) copyText(post);
  }
  if (read) {
    if (!apiAvailable) {
      const key = "rasd-read";
      const ids = new Set(JSON.parse(localStorage.getItem(key) || "[]"));
      if (ids.has(read.dataset.read)) ids.delete(read.dataset.read);
      else ids.add(read.dataset.read);
      localStorage.setItem(key, JSON.stringify([...ids]));
      await loadState();
      return;
    }
    await fetch(apiUrl("api/seen"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: read.dataset.read, toggle: true }),
    });
    await loadState();
  }
  if (remove) {
    if (!apiAvailable) {
      const key = "rasd-hidden";
      const ids = new Set(JSON.parse(localStorage.getItem(key) || "[]"));
      ids.add(remove.dataset.delete);
      localStorage.setItem(key, JSON.stringify([...ids]));
      await loadState();
      return;
    }
    await fetch(apiUrl(`api/posts?id=${encodeURIComponent(remove.dataset.delete)}`), { method: "DELETE" });
    await loadState();
  }
}

feed.addEventListener("click", onFeedClick);
likesFeed.addEventListener("click", onFeedClick);

document.querySelectorAll(".switch").forEach((button) => {
  button.addEventListener("click", () => {
    const id = button.id;
    if (id === "toggle-dark") prefs.dark = !prefs.dark;
    if (id === "toggle-unread") prefs.unreadOnly = !prefs.unreadOnly;
    if (id === "toggle-compact") prefs.compact = !prefs.compact;
    if (id === "toggle-refresh") prefs.autoRefresh = !prefs.autoRefresh;
    savePrefs();
    render();
  });
});

applyPrefs();
loadState().catch(() => {
  feed.innerHTML = `<div class="empty">تعذر تحميل الملخصات.</div>`;
});
