 
"use strict";

// ---------- SUPABASE CONFIG ----------
const SUPABASE_URL = "https://buahimnaohajxzmjaaiz.supabase.co";
const SUPABASE_PUBLISHABLE_KEY =
  "sb_publishable_LHf_ow-nU2dv5SRyr4qBqA_M4RhmtDt";

const supabaseClient = window.supabase.createClient(
  SUPABASE_URL,
  SUPABASE_PUBLISHABLE_KEY,
  {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true
    }
  }
);

const $ = id => document.getElementById(id);

let currentUser = null;
let currentProfile = null;
let activePage = "homeScreen";
let activeChat = null;
let profiles = [];
let chats = [];
let messages = [];
let groupRequests = [];
let realtimeChannel = null;
let refreshTimer = null;
let authMode = "login";

const BAD_WORDS = [
  "idiot", "stupid", "dumb", "moron", "bastard",
  "asshole", "fuck", "fucking", "shit", "bullshit",
  "bitch", "motherfucker", "madarchod", "behenchod",
  "bhenchod", "chutiya", "chutiye", "harami",
  "kamina", "kamine", "bsdk", "bkl", "lodu", "gandu"
];

// ---------- HELPERS ----------
function safeText(value) {
  return String(value ?? "").replace(/[&<>"']/g, ch => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;",
    '"': "&quot;", "'": "&#39;"
  })[ch]);
}

function usernameKey(value) {
  return String(value || "").trim().replace(/^@/, "").toLowerCase();
}

function makeId() {
  return crypto.randomUUID();
}

function displayName(profile) {
  return profile ? "@" + profile.username : "@unknown";
}

function toast(message) {
  const el = $("toast");
  if (!el) return;
  el.textContent = message;
  el.classList.add("show");
  setTimeout(() => el.classList.remove("show"), 2800);
}

function setAuthMessage(message) {
  $("authMessage").textContent = message;
}

function showAuth() {
  $("authScreen").hidden = false;
  $("mainScreen").hidden = true;
}

function showMain() {
  $("authScreen").hidden = true;
  $("mainScreen").hidden = false;
}

function setBusy(busy) {
  $("authSubmit").disabled = busy;
}

function isBanned() {
  return !!currentProfile?.banned;
}

function moderateText(input) {
  let text = String(input || "");
  let found = false;

  for (const word of [...BAD_WORDS].sort((a, b) => b.length - a.length)) {
    const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const regex = new RegExp(
      `(^|[^\\p{L}\\p{N}_])(${escaped})(?=$|[^\\p{L}\\p{N}_])`,
      "giu"
    );

    text = text.replace(regex, (match, before, bad) => {
      found = true;
      return before + "*".repeat(Math.max(3, [...bad].length));
    });
  }

  return { text, found };
}

// ---------- AUTH TABS ----------
document.querySelectorAll(".auth-tab").forEach(button => {
  button.addEventListener("click", () => {
    authMode = button.dataset.auth;

    document.querySelectorAll(".auth-tab").forEach(tab => {
      tab.classList.toggle("active", tab === button);
    });

    const signup = authMode === "signup";
    $("authName").hidden = !signup;
    $("nameLabel").hidden = !signup;
    $("authName").required = signup;
    $("authPassword").autocomplete =
      signup ? "new-password" : "current-password";
    $("authSubmit").textContent = signup ? "Create account" : "Login";
    setAuthMessage("");
  });
});

// ---------- SIGN UP / LOGIN ----------
$("authForm").addEventListener("submit", async event => {
  event.preventDefault();

  const email = $("authEmail").value.trim().toLowerCase();
  const password = $("authPassword").value;
  const username = usernameKey($("authName").value);

  if (password.length < 6) {
    setAuthMessage("Password must be at least 6 characters.");
    return;
  }

  if (authMode === "signup" &&
      !/^[a-z0-9_.]{3,24}$/.test(username)) {
    setAuthMessage(
      "Username must be 3–24 characters: letters, numbers, _ or ."
    );
    return;
  }

  setBusy(true);
  setAuthMessage("Please wait...");

  try {
    let result;

    if (authMode === "signup") {
      const redirectUrl = new URL(window.location.href);
      redirectUrl.hash = "";
      redirectUrl.search = "";

      result = await supabaseClient.auth.signUp({
        email,
        password,
        options: {
          data: { username },
          emailRedirectTo: redirectUrl.href
        }
      });
    } else {
      result = await supabaseClient.auth.signInWithPassword({
        email,
        password
      });
    }

    if (result.error) throw result.error;

    if (authMode === "signup" && !result.data.session) {
      $("authPassword").value = "";
      setAuthMessage(
        "Confirmation email bhej di gayi hai. Email ka link kholo, " +
        "phir isi website par wapas aakar login karo."
      );
      return;
    }

    currentUser = result.data.user;
    await loadProfile();

    $("authPassword").value = "";
    await enterApp();
  } catch (error) {
    setAuthMessage(error.message || "Authentication failed.");
  } finally {
    setBusy(false);
  }
});

// ---------- PROFILE ----------
async function loadProfile() {
  if (!currentUser) throw new Error("Please log in again.");

  const { data, error } = await supabaseClient
    .from("profiles")
    .select("id, username, warning_count, banned")
    .eq("id", currentUser.id)
    .maybeSingle();

  if (error) throw error;

  if (data) {
    currentProfile = data;
    return;
  }

  const proposed =
    currentUser.user_metadata?.username ||
    currentUser.email?.split("@")[0] ||
    "shadow_user";

  const cleanUsername = usernameKey(proposed).slice(0, 24);

  const { data: created, error: createError } = await supabaseClient
    .from("profiles")
    .insert({
      id: currentUser.id,
      username: cleanUsername,
      warning_count: 0,
      banned: false
    })
    .select("id, username, warning_count, banned")
    .single();

  if (createError) throw createError;
  currentProfile = created;
}

// ---------- ENTER APP ----------
async function enterApp() {
  if (!currentUser || !currentProfile) return;

  if (isBanned()) {
    await supabaseClient.auth.signOut();
    currentUser = null;
    currentProfile = null;
    showAuth();
    setAuthMessage("This account is suspended from messaging.");
    return;
  }

  showMain();
  $("accountUsername").textContent = displayName(currentProfile);
  $("accountEmail").textContent = currentUser.email || "";
  $("accountAvatar").textContent =
    currentProfile.username[0]?.toUpperCase() || "S";

  updateModerationStatus();
  await refreshData();
  showPage("homeScreen");
  subscribeRealtime();
}

function updateModerationStatus() {
  const el = $("moderationStatus");
  if (!el || !currentProfile) return;

  const count = Number(currentProfile.warning_count || 0);
  el.textContent = isBanned()
    ? "Account suspended."
    : `Safety status: ${count}/3 warnings. Keep messages respectful.`;
  el.classList.toggle("banned", isBanned());
}

// ---------- LOGOUT ----------
$("logoutBtn").addEventListener("click", async () => {
  try {
    if (realtimeChannel) {
      await supabaseClient.removeChannel(realtimeChannel);
      realtimeChannel = null;
    }

    const { error } = await supabaseClient.auth.signOut();
    if (error) throw error;

    currentUser = null;
    currentProfile = null;
    activeChat = null;
    showAuth();
    $("authForm").reset();
    document.querySelector('[data-auth="login"]').click();
    toast("Logged out.");
  } catch (error) {
    toast(error.message || "Logout failed.");
  }
});

// ---------- PAGE NAVIGATION ----------
function showPage(page) {
  if (!currentUser) return;

  activePage = page;
  activeChat = null;
  $("chatScreen").hidden = true;

  ["homeScreen", "groupsScreen", "safetyScreen", "accountScreen"]
    .forEach(id => {
      $(id).hidden = id !== page;
    });

  document.querySelectorAll(".nav-btn").forEach(button => {
    button.classList.toggle("active", button.dataset.page === page);
  });

  renderChats();
  renderGroups();
  renderRequests();
}

document.querySelectorAll(".nav-btn").forEach(button => {
  button.addEventListener("click", () => showPage(button.dataset.page));
});

$("profileBtn").addEventListener("click", () => showPage("accountScreen"));

$("backBtn").addEventListener("click", () => showPage("homeScreen"));

// ---------- LOAD SUPABASE DATA ----------
async function refreshData() {
  if (!currentUser) return;

  const [profileResult, chatResult, requestResult] = await Promise.all([
    supabaseClient
      .from("profiles")
      .select("id, username, warning_count, banned"),

    supabaseClient
      .from("chats")
      .select("id, name, type, category, created_by, members, updated_at")
      .contains("members", [currentUser.id])
      .order("updated_at", { ascending: false }),

    supabaseClient
      .from("group_requests")
      .select("*")
      .eq("to_user_id", currentUser.id)
      .eq("status", "pending")
  ]);

  if (profileResult.error) throw profileResult.error;
  if (chatResult.error) throw chatResult.error;
  if (requestResult.error) throw requestResult.error;

  profiles = profileResult.data || [];
  chats = chatResult.data || [];
  groupRequests = requestResult.data || [];

  currentProfile = profiles.find(p => p.id === currentUser.id) || currentProfile;

  if (isBanned()) {
    await enterApp();
    return;
  }

  renderChats();
  renderGroups();
  renderRequests();
  updateModerationStatus();
}

function profileFor(id) {
  return profiles.find(p => p.id === id);
}

function chatTitle(chat) {
  if (chat.type === "group") return chat.name;

  const otherId = (chat.members || []).find(id => id !== currentUser.id);
  return displayName(profileFor(otherId));
}

function getLastMessage(chatId) {
  const list = messages.filter(m => m.chat_id === chatId);
  return list.length ? list[list.length - 1].body : "No messages yet";
}

// ---------- CHAT LIST ----------

$("searchInput").addEventListener("input", async () => {
  $("clearSearch").hidden = !$("searchInput").value;

  if (currentUser) {
    const { data, error } = await supabaseClient
      .from("profiles")
      .select("id, username, warning_count, banned");

    if (error) {
      toast("User search failed: " + error.message);
      return;
    }

    profiles = data || [];
  }

  renderChats();
});


$("clearSearch").addEventListener("click", () => {
  $("searchInput").value = "";
  $("clearSearch").hidden = true;
  renderChats();
});

function renderChats() {
  if (!currentUser) return;

  const list = $("chatList");
  list.replaceChildren();

  const query = usernameKey($("searchInput").value);
  const visible = chats.filter(chat =>
    !query ||
    usernameKey(chatTitle(chat)).includes(query) ||
    usernameKey(getLastMessage(chat.id)).includes(query)
  );

  $("chatCount").textContent = visible.length;
  $("emptyState").hidden = visible.length > 0 || !!query;

  visible.forEach(chat => {
    const row = document.createElement("div");
    row.className = "chat-row";

    const avatar = document.createElement("div");
    avatar.className = "avatar";
    avatar.textContent = chatTitle(chat).replace("@", "")[0]?.toUpperCase() || "S";

    const info = document.createElement("div");
    info.className = "chat-info";

    const title = document.createElement("h3");
    title.textContent = chatTitle(chat);

    const preview = document.createElement("p");
    preview.textContent = getLastMessage(chat.id);

    info.append(title, preview);
    row.append(avatar, info);
    row.addEventListener("click", () => openChat(chat.id));
    list.append(row);
  });

  if (query) {
    profiles
      .filter(p => p.id !== currentUser.id &&
        !p.banned &&
        usernameKey(p.username).includes(query))
      .forEach(profile => {
        const row = document.createElement("div");
        row.className = "chat-row";

        const info = document.createElement("div");
        info.className = "chat-info";
        info.innerHTML =
          `<h3>${safeText(displayName(profile))}</h3><p>Start a private chat</p>`;

        row.append(info);
        row.addEventListener("click", () => startDirectChat(profile));
        list.append(row);
      });
  }
}

// ---------- CREATE / OPEN PRIVATE CHAT ----------
$("newChatBtn").addEventListener("click", openFindPeople);
$("emptyNewChat").addEventListener("click", openFindPeople);

function openFindPeople() {
  $("dialogTitle").textContent = "Find people";
  $("dialogBody").innerHTML = `
    <label class="dialog-label" for="peopleSearch">Username</label>
    <input class="dialog-input" id="peopleSearch"
      placeholder="Enter username" maxlength="24">
    <div id="peopleResults" class="result-list"></div>`;
  $("actionDialog").showModal();

  $("peopleSearch").addEventListener("input", renderPeopleResults);
  renderPeopleResults();
}

function renderPeopleResults() {
  const input = $("peopleSearch");
  const results = $("peopleResults");
  if (!input || !results) return;

  const query = usernameKey(input.value);
  results.replaceChildren();

  if (!query) return;

  profiles
    .filter(p => p.id !== currentUser.id && !p.banned &&
      usernameKey(p.username).includes(query))
    .forEach(profile => {
      const row = document.createElement("div");
      row.className = "result-row";

      const name = document.createElement("strong");
      name.textContent = displayName(profile);

      const button = document.createElement("button");
      button.type = "button";
      button.textContent = "Chat";
      button.addEventListener("click", async () => {
        $("actionDialog").close();
        await startDirectChat(profile);
      });

      row.append(name, button);
      results.append(row);
    });
}

async function startDirectChat(profile) {
  try {
    if (!profile || profile.banned) return toast("Account unavailable.");

    const existing = chats.find(c =>
      c.type === "direct" &&
      c.members.includes(currentUser.id) &&
      c.members.includes(profile.id)
    );

    if (existing) return openChat(existing.id);

    const { data, error } = await supabaseClient
      .from("chats")
      .insert({
        name: "",
        type: "direct",
        category: "Private",
        created_by: currentUser.id,
        members: [currentUser.id, profile.id]
      })
      .select()
      .single();

    if (error) throw error;

    await refreshData();
    openChat(data.id);
  } catch (error) {
    toast(error.message || "Could not create chat.");
  }
}

// ---------- OPEN CHAT AND MESSAGES ----------
async function openChat(chatId) {
  const chat = chats.find(c => c.id === chatId);
  if (!chat) return toast("Chat not found.");

  activeChat = chat;
  $("homeScreen").hidden = true;
  $("groupsScreen").hidden = true;
  $("safetyScreen").hidden = true;
  $("accountScreen").hidden = true;
  $("chatScreen").hidden = false;

  $("chatTitle").textContent = chatTitle(chat);
  $("chatSubtitle").textContent =
    chat.type === "group" ? `${chat.members.length} members` : "Private chat";
  $("chatAvatar").textContent =
    chatTitle(chat).replace("@", "")[0]?.toUpperCase() || "S";

  await loadMessages(chat.id);
}

async function loadMessages(chatId) {
  const { data, error } = await supabaseClient
    .from("messages")
    .select("id, chat_id, sender_id, body, created_at")
    .eq("chat_id", chatId)
    .order("created_at", { ascending: true })
    .limit(500);

  if (error) {
    toast(error.message);
    return;
  }

  messages = (data || []).filter(m => m.chat_id === chatId);
  renderMessages();
}

function renderMessages() {
  const list = $("messageList");
  list.replaceChildren();

  if (!activeChat) return;

  messages.filter(m => m.chat_id === activeChat.id).forEach(message => {
    const bubble = document.createElement("div");
    bubble.className =
      "message" + (message.sender_id === currentUser.id ? " mine" : "");

    const sender = document.createElement("span");
    sender.className = "sender";
    sender.textContent = message.sender_id === currentUser.id
      ? "You"
      : displayName(profileFor(message.sender_id));

    const content = document.createElement("div");
    content.textContent = message.body;

    const time = document.createElement("span");
    time.className = "time";
    time.textContent = new Date(message.created_at)
      .toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

    bubble.append(sender, content, time);
    list.append(bubble);
  });

  list.scrollTop = list.scrollHeight;
}

// ---------- SEND MESSAGE ----------
$("messageForm").addEventListener("submit", async event => {
  event.preventDefault();

  if (!currentUser || !activeChat || isBanned()) {
    return toast("Messaging is unavailable.");
  }

  const raw = $("messageInput").value.trim();
  if (!raw) return;

  const result = moderateText(raw);
  $("messageInput").value = "";

  try {
    if (result.found) {
      const nextCount = Number(currentProfile.warning_count || 0) + 1;

      const { data, error } = await supabaseClient
        .from("profiles")
        .update({
          warning_count: nextCount,
          banned: nextCount >= 3
        })
        .eq("id", currentUser.id)
        .select("id, username, warning_count, banned")
        .single();

      if (error) throw error;

      currentProfile = data;
      updateModerationStatus();

      if (data.banned) {
        toast("Account suspended after repeated violations.");
        await enterApp();
        return;
      }

      toast(`Warning ${nextCount}/3. Abusive words were masked.`);
    }

    const { error } = await supabaseClient
      .from("messages")
      .insert({
        chat_id: activeChat.id,
        sender_id: currentUser.id,
        body: result.text
      });

    if (error) throw error;

    await loadMessages(activeChat.id);
    await refreshData();
  } catch (error) {
    toast(error.message || "Message could not be sent.");
  }
});

// ---------- GROUP CREATION ----------
$("newGroupBtn").addEventListener("click", openCreateGroup);
$("groupsNewBtn").addEventListener("click", openCreateGroup);

function openCreateGroup() {
  $("dialogTitle").textContent = "Create group";
  $("dialogBody").innerHTML = `
    <form id="groupForm">
      <label class="dialog-label" for="groupName">Group name</label>
      <input class="dialog-input" id="groupName"
        maxlength="60" required placeholder="School Community">

      <label class="dialog-label" for="groupType">Group type</label>
      <select class="dialog-input" id="groupType">
        <option>School</option>
        <option>College</option>
        <option>Company</option>
        <option>Public Community</option>
        <option>Private</option>
      </select>

      <button class="primary-btn dialog-submit" type="submit">
        Create group
      </button>
    </form>`;

  $("actionDialog").showModal();

  $("groupForm").addEventListener("submit", async event => {
    event.preventDefault();

    const name = $("groupName").value.trim();
    const category = $("groupType").value;
    if (!name) return;

    try {
      const { data, error } = await supabaseClient
        .from("chats")
        .insert({
          name,
          type: "group",
          category,
          created_by: currentUser.id,
          members: [currentUser.id]
        })
        .select()
        .single();

      if (error) throw error;

      $("actionDialog").close();
      await refreshData();
      showPage("groupsScreen");
      toast("Group created.");

    } catch (error) {
      toast(error.message || "Could not create group.");
    }
  });
}

// ---------- GROUP LIST ----------
function renderGroups() {
  const list = $("groupsList");
  if (!list) return;
  list.replaceChildren();

  const groups = chats.filter(c => c.type === "group");

  if (!groups.length) {
    list.textContent = "No groups yet. Create a new group to begin.";
    return;
  }

  groups.forEach(chat => {
    const row = document.createElement("div");
    row.className = "chat-row";

    const info = document.createElement("div");
    info.className = "chat-info";

    const title = document.createElement("h3");
    title.textContent = chat.name;

    const details = document.createElement("p");
    details.textContent = `${chat.category || "Group"} · ${chat.members.length} members`;

    info.append(title, details);
    row.append(info);
    row.addEventListener("click", () => openChat(chat.id));
    list.append(row);
  });
}

// ---------- GROUP REQUESTS ----------
function renderRequests() {
  const list = $("groupRequestsList");
  const count = $("groupRequestCount");
  if (!list || !count) return;

  list.replaceChildren();
  count.textContent = groupRequests.length;

  if (!groupRequests.length) {
    list.textContent = "No pending group requests.";
    return;
  }

  groupRequests.forEach(request => {
    const row = document.createElement("div");
    row.className = "group-request-card";

    const title = document.createElement("h3");
    title.textContent = request.group_name || "Group invitation";

    const accept = document.createElement("button");
    accept.type = "button";
    accept.className = "primary-btn";
    accept.textContent = "Accept";
    accept.addEventListener("click", () => respondToRequest(request, true));

    const reject = document.createElement("button");
    reject.type = "button";
    reject.className = "danger-btn";
    reject.textContent = "Reject";
    reject.addEventListener("click", () => respondToRequest(request, false));

    row.append(title, accept, reject);
    list.append(row);
  });
}

async function respondToRequest(request, accept) {
  try {
    if (accept) {
      const { data: group, error: fetchError } = await supabaseClient
        .from("chats")
        .select("id, members")
        .eq("id", request.group_id)
        .single();

      if (fetchError) throw fetchError;

      const members = [...new Set([...(group.members || []), currentUser.id])];

      const { error: updateError } = await supabaseClient
        .from("chats")
        .update({ members })
        .eq("id", group.id);

      if (updateError) throw updateError;
    }

    const { error } = await supabaseClient
      .from("group_requests")
      .update({ status: accept ? "accepted" : "rejected" })
      .eq("id", request.id)
      .eq("to_user_id", currentUser.id);

    if (error) throw error;

    await refreshData();
    toast(accept ? "Group joined." : "Request rejected.");
  } catch (error) {
    toast(error.message || "Could not update request.");
  }
}

// ---------- CHAT OPTIONS ----------
$("chatMenuBtn").addEventListener("click", () => {
  if (!activeChat) return;

  $("dialogTitle").textContent = "Chat options";
  $("dialogBody").replaceChildren();

  const info = document.createElement("p");
  info.textContent = activeChat.type === "group"
    ? "Group: " + activeChat.name
    : "Private conversation";

  $("dialogBody").append(info);
  $("actionDialog").showModal();
});

// ---------- REALTIME ----------
function subscribeRealtime() {
  if (realtimeChannel) {
    supabaseClient.removeChannel(realtimeChannel);
  }

  realtimeChannel = supabaseClient
    .channel("shadowchat-" + currentUser.id)

    .on("postgres_changes", {
      event: "INSERT",
      schema: "public",
      table: "messages"
    }, async payload => {
      if (activeChat && payload.new.chat_id === activeChat.id) {
        await loadMessages(activeChat.id);
      }
      await refreshData();
    })

    .on("postgres_changes", {
      event: "*",
      schema: "public",
      table: "chats"
    }, async () => {
      await refreshData();
    })

    .on("postgres_changes", {
      event: "*",
      schema: "public",
      table: "group_requests",
      filter: "to_user_id=eq." + currentUser.id
    }, async () => {
      await refreshData();
    })

    .subscribe();
}

// ---------- STARTUP / EMAIL CONFIRMATION ----------
async function startApp() {
  try {
    const { data, error } = await supabaseClient.auth.getSession();
    if (error) throw error;

    if (data.session?.user) {
      currentUser = data.session.user;
      await loadProfile();
      await enterApp();
    } else {
      showAuth();
    }

    // If email confirmation returns the user to this page,
    // the Supabase session will be checked again.
    supabaseClient.auth.onAuthStateChange((event, session) => {
      if (session?.user && !currentUser) {
        currentUser = session.user;
        setTimeout(async () => {
          try {
            await loadProfile();
            await enterApp();
          } catch (err) {
            setAuthMessage(err.message || "Could not load profile.");
          }
        }, 0);
      }
    });
  } catch (error) {
    showAuth();
    setAuthMessage(error.message || "Could not connect to Supabase.");
  }
}

startApp();
