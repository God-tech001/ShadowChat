 "use strict";

// ---------- SUPABASE CONFIG ----------
const SUPABASE_URL = "https://buahimnaohajxzmjaaiz.supabase.co";
const SUPABASE_PUBLISHABLE_KEY = "sb_publishable_KJv27qXL8VG-tDc0PaL9oQ_rxm8bVo9";

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
let hiddenChatIds = new Set();
let blockedUserIds = new Set();
let adminGroupIds = new Set();
let realtimeChannel = null;
let authListener = null;
let authMode = "login";

const BAD_WORDS = [
  "idiot", "stupid", "dumb", "moron", "bastard",
  "asshole", "fuck", "fucking", "shit", "bullshit",
  "bitch", "motherfucker", "madarchod", "behenchod",
  "bhenchod", "chutiya", "chutiye", "harami",
  "kamina", "kamine", "bsdk", "bkl", "lodu", "gandu"
];

// ---------- HELPERS ----------
function usernameKey(value) {
  return String(value || "").trim().replace(/^@/, "").toLowerCase();
}

function displayName(profile) {
  return profile ? "@" + profile.username : "@unknown";
}

function toast(message) {
  const el = $("toast");
  if (!el) {
    console.log(message);
    return;
  }

  el.textContent = message;
  el.classList.add("show");
  setTimeout(() => el.classList.remove("show"), 2800);
}

function setAuthMessage(message) {
  if ($("authMessage")) $("authMessage").textContent = message;
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

function profileFor(id) {
  return profiles.find(p => p.id === id);
}

function chatTitle(chat) {
  if (chat.type === "group") return chat.name || "Group";

  const otherId = (chat.members || []).find(id => id !== currentUser.id);
  return displayName(profileFor(otherId));
}

// Creator is always an admin. Other admins are loaded from Supabase.
function isGroupAdmin(chat, userId = currentUser?.id) {
  if (!chat || chat.type !== "group" || !userId) return false;

  return chat.created_by === userId ||
    (userId === currentUser?.id && adminGroupIds.has(chat.id)) ||
    chat._adminIds?.includes(userId);
}

function isGroupCreator(chat) {
  return !!chat && chat.created_by === currentUser?.id;
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

  if (!email || password.length < 6) {
    setAuthMessage("Enter a valid email and password of at least 6 characters.");
    return;
  }

  if (
    authMode === "signup" &&
    !/^[a-z0-9_.]{3,24}$/.test(username)
  ) {
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
        "Confirmation email bheji gayi hai. Email ka link kholo, phir login karo."
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
    chats = [];
    messages = [];
    hiddenChatIds.clear();
    blockedUserIds.clear();
    adminGroupIds.clear();

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

  const [
    profileResult,
    chatResult,
    requestResult,
    hiddenResult,
    blockResult
  ] = await Promise.all([
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
      .eq("status", "pending"),

    supabaseClient
      .from("hidden_chats")
      .select("group_id")
      .eq("user_id", currentUser.id),

    supabaseClient
      .from("user_blocks")
      .select("blocked_user_id")
      .eq("blocker_id", currentUser.id)
  ]);

  for (const result of [
    profileResult, chatResult, requestResult, hiddenResult, blockResult
  ]) {
    if (result.error) throw result.error;
  }

  profiles = profileResult.data || [];
  chats = chatResult.data || [];
  groupRequests = requestResult.data || [];

  hiddenChatIds = new Set(
    (hiddenResult.data || []).map(row => row.group_id)
  );

  blockedUserIds = new Set(
    (blockResult.data || []).map(row => row.blocked_user_id)
  );

  currentProfile =
    profiles.find(p => p.id === currentUser.id) || currentProfile;

  // Load the additional admins for groups the user belongs to.
  adminGroupIds.clear();

  const groupIds = chats
    .filter(chat => chat.type === "group")
    .map(chat => chat.id);

  if (groupIds.length) {
    const { data: adminRows, error: adminError } = await supabaseClient
      .from("group_admins")
      .select("group_id, user_id")
      .in("group_id", groupIds);

    if (adminError) {
      console.warn("Could not load group admins:", adminError.message);
      // Creator still works as admin if this table or its policies are not set up.
    } else {
      chats.forEach(chat => {
        chat._adminIds = (adminRows || [])
          .filter(row => row.group_id === chat.id)
          .map(row => row.user_id);
      });

      (adminRows || []).forEach(row => {
        if (row.user_id === currentUser.id) {
          adminGroupIds.add(row.group_id);
        }
      });
    }
  }

  if (isBanned()) {
    await enterApp();
    return;
  }

  renderChats();
  renderGroups();
  renderRequests();
  updateModerationStatus();
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
    !hiddenChatIds.has(chat.id) &&
    (
      !query ||
      usernameKey(chatTitle(chat)).includes(query) ||
      usernameKey(getLastMessage(chat.id)).includes(query)
    )
  );

  $("chatCount").textContent = visible.length;
  $("emptyState").hidden = visible.length > 0 || !!query;

  visible.forEach(chat => {
    const row = document.createElement("div");
    row.className = "chat-row";

    const avatar = document.createElement("div");
    avatar.className = "avatar";
    avatar.textContent =
      chatTitle(chat).replace("@", "")[0]?.toUpperCase() || "S";

    const info = document.createElement("div");
    info.className = "chat-info";

    const title = document.createElement("h3");
    title.textContent = chatTitle(chat);

    const preview = document.createElement("p");
    preview.textContent = getLastMessage(chat.id);

    // No three-dot menu in the chat list.
    info.append(title, preview);
    row.append(avatar, info);
    row.addEventListener("click", () => openChat(chat.id));
    list.append(row);
  });

  if (query) {
    profiles
      .filter(p =>
        p.id !== currentUser.id &&
        !p.banned &&
        usernameKey(p.username).includes(query)
      )
      .forEach(profile => {
        const existing = chats.some(c =>
          c.type === "direct" &&
          (c.members || []).includes(profile.id) &&
          (c.members || []).includes(currentUser.id) &&
          !hiddenChatIds.has(c.id)
        );

        if (existing) return;

        const row = document.createElement("div");
        row.className = "chat-row";

        const info = document.createElement("div");
        info.className = "chat-info";

        const name = document.createElement("h3");
        name.textContent = displayName(profile);

        const subtitle = document.createElement("p");
        subtitle.textContent = "Start a private chat";

        info.append(name, subtitle);
        row.append(info);
        row.addEventListener("click", () => startDirectChat(profile));
        list.append(row);
      });
  }
}

// ---------- FIND PEOPLE ----------
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
    .filter(p =>
      p.id !== currentUser.id &&
      !p.banned &&
      usernameKey(p.username).includes(query)
    )
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

// ---------- CREATE PRIVATE CHAT ----------
async function startDirectChat(profile) {
  try {
    if (!profile || profile.banned) {
      return toast("Account unavailable.");
    }

    if (blockedUserIds.has(profile.id)) {
      return toast("Tumne is user ko block kiya hai. Pehle unblock karo.");
    }

    const existing = chats.find(c =>
      c.type === "direct" &&
      (c.members || []).includes(currentUser.id) &&
      (c.members || []).includes(profile.id)
    );

    if (existing) {
      if (hiddenChatIds.has(existing.id)) {
        const { error } = await supabaseClient
          .from("hidden_chats")
          .delete()
          .eq("user_id", currentUser.id)
          .eq("group_id", existing.id);

        if (error) throw error;
        hiddenChatIds.delete(existing.id);
      }

      await refreshData();
      return openChat(existing.id);
    }

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

// ---------- OPEN CHAT ----------
async function openChat(chatId) {
  const chat = chats.find(c => c.id === chatId);

  if (!chat) return toast("Chat not found.");
  if (hiddenChatIds.has(chatId)) return toast("This chat is hidden.");

  activeChat = chat;

  $("homeScreen").hidden = true;
  $("groupsScreen").hidden = true;
  $("safetyScreen").hidden = true;
  $("accountScreen").hidden = true;
  $("chatScreen").hidden = false;

  $("chatTitle").textContent = chatTitle(chat);
  $("chatSubtitle").textContent =
    chat.type === "group"
      ? `${(chat.members || []).length} members` +
        (isGroupAdmin(chat) ? " · Admin" : "")
      : "Private chat";

  $("chatAvatar").textContent =
    chatTitle(chat).replace("@", "")[0]?.toUpperCase() || "S";

  await loadMessages(chat.id);
}

// ---------- LOAD / RENDER MESSAGES ----------
async function loadMessages(chatId) {
  const { data, error } = await supabaseClient
    .from("messages")
    .select("id, chat_id, sender_id, message, created_at")
    .eq("chat_id", chatId)
    .order("created_at", { ascending: true })
    .limit(500);

  if (error) {
    toast(error.message);
    return;
  }

  messages = (data || [])
    .filter(m => m.chat_id === chatId)
    .map(m => ({ ...m, body: m.message }));

  renderMessages();
}

function renderMessages() {
  const list = $("messageList");
  list.replaceChildren();

  if (!activeChat) return;

  messages
    .filter(m => m.chat_id === activeChat.id)
    .forEach(message => {
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

  const otherId = activeChat.type === "direct"
    ? (activeChat.members || []).find(id => id !== currentUser.id)
    : null;

  if (otherId && blockedUserIds.has(otherId)) {
    return toast("You blocked this user. Unblock them to continue.");
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
        message: result.text
      });

    if (error) throw error;

    await loadMessages(activeChat.id);
    await refreshData();
  } catch (error) {
    toast(error.message || "Message could not be sent.");
  }
});

// ---------- CREATE GROUP ----------
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

      const { error: memberError } = await supabaseClient
        .from("group_members")
        .insert({
          group_id: data.id,
          user_id: currentUser.id
        });

      if (memberError) {
        console.warn("Group membership row failed:", memberError.message);
      }

      // Store the creator in group_admins as well.
      const { error: adminError } = await supabaseClient
        .from("group_admins")
        .upsert(
          { group_id: data.id, user_id: currentUser.id },
          { onConflict: "group_id,user_id" }
        );

      if (adminError) {
        console.warn("Creator remains admin through created_by:", adminError.message);
      }

      $("actionDialog").close();
      await refreshData();
      showPage("groupsScreen");
      toast("Group created. You are the group admin.");
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

  const groups = chats.filter(c =>
    c.type === "group" && !hiddenChatIds.has(c.id)
  );

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
    details.textContent =
      `${chat.category || "Group"} · ${(chat.members || []).length} members` +
      (isGroupAdmin(chat) ? " · You are admin" : "");

    const spacer = document.createElement("span");
    spacer.textContent = "";

    info.append(title, details);
    row.append(info, spacer);
    row.addEventListener("click", () => openChat(chat.id));
    list.append(row);
  });
}

// ---------- CHAT OPTIONS: INSIDE CHAT ONLY ----------
$("chatMenuBtn").addEventListener("click", event => {
  event.preventDefault();
  event.stopPropagation();

  if (activeChat) {
    openChatOptions(activeChat.id);
  } else {
    toast("Pehle chat kholo.");
  }
});

function openChatOptions(chatId) {
  const chat = chats.find(c => c.id === chatId);

  if (!chat || !currentUser) return;

  $("dialogTitle").textContent =
    chat.type === "group" ? "Group Options" : "Chat Options";

  const body = $("dialogBody");
  body.replaceChildren();

  function addOption(label, handler, danger = false) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = danger ? "danger-btn" : "primary-btn";
    button.textContent = label;
    button.style.margin = "6px";

    button.addEventListener("click", async () => {
      await handler();
    });

    body.append(button);
  }

  addOption("Delete / Hide Chat", () => hideChat(chat), true);

  if (chat.type === "direct") {
    const otherId = (chat.members || [])
      .find(id => id !== currentUser.id);

    if (otherId) {
      const blocked = blockedUserIds.has(otherId);

      addOption(
        blocked ? "Unblock User" : "Block User",
        async () => {
          $("actionDialog").close();
          if (blocked) await unblockUser(otherId);
          else await blockUser(otherId);
        },
        !blocked
      );
    }
  }

  if (chat.type === "group") {
    const admin = isGroupAdmin(chat);

    const summary = document.createElement("p");
    summary.className = "dialog-help";
    summary.textContent = admin
      ? `You are an admin. Members: ${(chat.members || []).length}`
      : `Members: ${(chat.members || []).length}`;

    body.append(summary);

    if (admin) {
      addOption("＋ Add Members", () => openAddMembers(chat));

      addOption("Manage Group Admins", () => openManageGroupAdmins(chat));

      addOption("View Group Members", () => showGroupMembers(chat));
    } else {
      addOption("View Group Admin", () => showGroupAdmins(chat));
    }

    addOption("Leave Group", async () => {
      $("actionDialog").close();
      await leaveGroup(chat);
    }, true);
  }
  addOption("Cancel", async () => {
    $("actionDialog").close();
  });

  const dialog = $("actionDialog");

  if (dialog && !dialog.open) {
    dialog.showModal();
  }
}


// ---------- VIEW GROUP MEMBERS ----------
function showGroupMembers(chat) {
  $("dialogTitle").textContent = "Group Members";

  const body = $("dialogBody");
  body.replaceChildren();

  (chat.members || []).forEach(memberId => {
    const profile = profileFor(memberId);
    if (!profile) return;

    const row = document.createElement("div");
    row.className = "member-row";

    const info = document.createElement("div");
    info.className = "member-info";

    const name = document.createElement("strong");
    name.textContent = displayName(profile);

    const role = document.createElement("small");
    role.textContent = isGroupAdmin(chat, memberId) ? "Admin" : "Member";

    info.append(name, role);
    row.append(info);
    body.append(row);
  });

  $("actionDialog").showModal();
}

// ---------- VIEW GROUP ADMINS ----------
function showGroupAdmins(chat) {
  $("dialogTitle").textContent = "Group Admins";

  const body = $("dialogBody");
  body.replaceChildren();

  const adminIds = new Set([
    chat.created_by,
    ...(chat._adminIds || [])
  ]);

  adminIds.forEach(id => {
    const profile = profileFor(id);
    if (!profile) return;

    const row = document.createElement("div");
    row.className = "member-row";

    const info = document.createElement("div");
    info.className = "member-info";

    const name = document.createElement("strong");
    name.textContent = displayName(profile);

    const role = document.createElement("small");
    role.textContent = id === chat.created_by
      ? "Creator · Admin"
      : "Group Admin";

    info.append(name, role);
    row.append(info);
    body.append(row);
  });

  $("actionDialog").showModal();
}

// ---------- MANAGE MULTIPLE GROUP ADMINS ----------
function openManageGroupAdmins(chat) {
  if (!isGroupAdmin(chat)) {
    return toast("Sirf group admins ye option use kar sakte hain.");
  }

  $("dialogTitle").textContent = "Manage Group Admins";

  const body = $("dialogBody");
  body.replaceChildren();

  const help = document.createElement("p");
  help.className = "dialog-help";
  help.textContent = isGroupCreator(chat)
    ? "Admins add/remove kar sakte ho. Group creator permanent admin rahega."
    : "Aap members ko admin bana sakte ho. Existing admins ko remove karne ka adhikar creator ko hai.";

  body.append(help);

  const list = document.createElement("div");
  list.className = "member-list";
  body.append(list);

  function renderAdminList() {
    list.replaceChildren();

    (chat.members || []).forEach(memberId => {
      const profile = profileFor(memberId);
      if (!profile) return;

      const row = document.createElement("div");
      row.className = "member-row";

      const info = document.createElement("div");
      info.className = "member-info";

      const name = document.createElement("strong");
      name.textContent = displayName(profile);

      const isAdmin = isGroupAdmin(chat, memberId);

      const role = document.createElement("small");
      role.textContent = memberId === chat.created_by
        ? "Creator · Permanent Admin"
        : isAdmin ? "Admin" : "Member";

      info.append(name, role);
      row.append(info);

      if (memberId !== chat.created_by && memberId !== currentUser.id) {
        if (!isAdmin) {
          const promote = document.createElement("button");
          promote.type = "button";
          promote.className = "small-btn";
          promote.textContent = "Make Admin";

          promote.addEventListener("click", async () => {
            promote.disabled = true;

            try {
              const { error } = await supabaseClient
                .from("group_admins")
                .upsert(
                  { group_id: chat.id, user_id: memberId },
                  { onConflict: "group_id,user_id" }
                );

              if (error) throw error;

              chat._adminIds = [
                ...new Set([...(chat._adminIds || []), memberId])
              ];

              if (memberId === currentUser.id) {
                adminGroupIds.add(chat.id);
              }

              toast(`${displayName(profile)} is now an admin.`);
              await refreshData();
              openManageGroupAdmins(chats.find(c => c.id === chat.id) || chat);
            } catch (error) {
              toast("Admin nahi bana: " + error.message);
              promote.disabled = false;
            }
          });

          row.append(promote);
        } else if (isGroupCreator(chat)) {
          const demote = document.createElement("button");
          demote.type = "button";
          demote.className = "small-btn danger";
          demote.textContent = "Remove Admin";

          demote.addEventListener("click", async () => {
            demote.disabled = true;

            try {
              const { error } = await supabaseClient
                .from("group_admins")
                .delete()
                .eq("group_id", chat.id)
                .eq("user_id", memberId);

              if (error) throw error;

              chat._adminIds = (chat._adminIds || [])
                .filter(id => id !== memberId);

              toast(`${displayName(profile)} is no longer an admin.`);
              await refreshData();
              openManageGroupAdmins(chats.find(c => c.id === chat.id) || chat);
            } catch (error) {
              toast("Admin remove nahi hua: " + error.message);
              demote.disabled = false;
            }
          });

          row.append(demote);
        }
      }

      list.append(row);
    });

    if (!list.children.length) {
      list.textContent = "No group members found.";
    }
  }

  renderAdminList();
  $("actionDialog").showModal();
}

// ---------- HIDE CHAT: CURRENT USER ONLY ----------
async function hideChat(chat) {
  if (!confirm(
    "Ye chat sirf tumhari list se hide hogi. Doosre members ke messages delete nahi honge. Continue?"
  )) return;

  try {
    const { data: existing, error: findError } = await supabaseClient
      .from("hidden_chats")
      .select("group_id")
      .eq("user_id", currentUser.id)
      .eq("group_id", chat.id)
      .maybeSingle();

    if (findError) throw findError;

    if (!existing) {
      const { error } = await supabaseClient
        .from("hidden_chats")
        .insert({
          user_id: currentUser.id,
          group_id: chat.id
        });

      if (error) throw error;
    }

    hiddenChatIds.add(chat.id);

    if (activeChat?.id === chat.id) {
      activeChat = null;
      $("chatScreen").hidden = true;
      $("homeScreen").hidden = false;
    }

    $("actionDialog").close();
    renderChats();
    renderGroups();
    toast("Chat tumhari list se hide ho gayi.");
  } catch (error) {
    toast("Chat hide nahi hui: " + error.message);
  }
}

// ---------- BLOCK / UNBLOCK USER ----------
async function blockUser(userId) {
  if (!userId || userId === currentUser.id) return;

  if (!confirm("Kya tum is user ko block karna chahte ho?")) return;

  try {
    const { data: existing, error: findError } = await supabaseClient
      .from("user_blocks")
      .select("blocked_user_id")
      .eq("blocker_id", currentUser.id)
      .eq("blocked_user_id", userId)
      .maybeSingle();

    if (findError) throw findError;

    if (!existing) {
      const { error } = await supabaseClient
        .from("user_blocks")
        .insert({
          blocker_id: currentUser.id,
          blocked_user_id: userId
        });

      if (error) throw error;
    }

    blockedUserIds.add(userId);
    toast("User blocked.");
  } catch (error) {
    toast("Block nahi hua: " + error.message);
  }
}

async function unblockUser(userId) {
  try {
    const { error } = await supabaseClient
      .from("user_blocks")
      .delete()
      .eq("blocker_id", currentUser.id)
      .eq("blocked_user_id", userId);

    if (error) throw error;

    blockedUserIds.delete(userId);
    toast("User unblocked.");
  } catch (error) {
    toast("Unblock nahi hua: " + error.message);
  }
}

// ---------- ADD GROUP MEMBERS ----------
function openAddMembers(chat) {
  if (!isGroupAdmin(chat)) {
    return toast("Sirf group admin members add kar sakta hai.");
  }

  $("dialogTitle").textContent = "Add Members";
  $("dialogBody").replaceChildren();

  const search = document.createElement("input");
  search.className = "dialog-input";
  search.placeholder = "Username search karo";
  search.maxLength = 24;

  const results = document.createElement("div");
  results.className = "result-list";

  $("dialogBody").append(search, results);
  $("actionDialog").showModal();

  async function renderResults() {
    results.replaceChildren();

    const query = usernameKey(search.value);

    const matches = profiles.filter(profile =>
      profile.id !== currentUser.id &&
      !profile.banned &&
      !(chat.members || []).includes(profile.id) &&
      usernameKey(profile.username).includes(query)
    );

    for (const profile of matches) {
      const row = document.createElement("div");
      row.className = "result-row";

      const name = document.createElement("strong");
      name.textContent = displayName(profile);

      const button = document.createElement("button");
      button.type = "button";
      button.className = "primary-btn";
      button.textContent = "Add";

      button.addEventListener("click", async () => {
        button.disabled = true;

        try {
          if (!isGroupAdmin(chat)) {
            throw new Error("Only group admins can add members.");
          }

          // Fetch latest group membership before updating.
          const { data: latest, error: latestError } = await supabaseClient
            .from("chats")
            .select("id, members, created_by")
            .eq("id", chat.id)
            .single();

          if (latestError) throw latestError;

          const latestChat = chats.find(c => c.id === chat.id);

          if (
            latest.created_by !== currentUser.id &&
            !isGroupAdmin(latestChat)
          ) {
            throw new Error("Only group admins can add members.");
          }

          const members = [...new Set([
            ...(latest.members || []),
            profile.id
          ])];

          const { error: updateError } = await supabaseClient
            .from("chats")
            .update({
              members,
              updated_at: new Date().toISOString()
            })
            .eq("id", chat.id);

          if (updateError) throw updateError;

          const { data: existing, error: findError } = await supabaseClient
            .from("group_members")
            .select("user_id")
            .eq("group_id", chat.id)
            .eq("user_id", profile.id)
            .maybeSingle();

          if (findError) throw findError;

          if (!existing) {
            const { error: insertError } = await supabaseClient
              .from("group_members")
              .insert({
                group_id: chat.id,
                user_id: profile.id
              });

            if (insertError) throw insertError;
          }

          chat.members = members;
          toast(displayName(profile) + " added to group.");
          await refreshData();
          renderResults();
        } catch (error) {
          toast("Member add nahi hua: " + error.message);
        } finally {
          button.disabled = false;
        }
      });

      row.append(name, button);
      results.append(row);
    }

    if (!results.children.length) {
      results.textContent = "Koi naya member nahi mila.";
    }
  }

  search.addEventListener("input", renderResults);
  renderResults();
}

// ---------- LEAVE GROUP ----------
async function leaveGroup(chat) {
  if (!chat || chat.type !== "group") return;

  if (!confirm("Kya tum is group ko chhodna chahte ho?")) return;

  if (chat.created_by === currentUser.id) {
    return toast(
      "Group creator abhi group nahi chhod sakta. Pehle group transfer feature chahiye."
    );
  }

  try {
    const members = (chat.members || [])
      .filter(id => id !== currentUser.id);

    const { error: updateError } = await supabaseClient
      .from("chats")
      .update({
        members,
        updated_at: new Date().toISOString()
      })
      .eq("id", chat.id);

    if (updateError) throw updateError;

    const { error: memberError } = await supabaseClient
      .from("group_members")
      .delete()
      .eq("group_id", chat.id)
      .eq("user_id", currentUser.id);

    if (memberError) {
      console.warn("Membership row removal failed:", memberError.message);
    }

    await supabaseClient
      .from("group_admins")
      .delete()
      .eq("group_id", chat.id)
      .eq("user_id", currentUser.id);

    $("actionDialog").close();
    activeChat = null;
    $("chatScreen").hidden = true;

    await refreshData();
    showPage("groupsScreen");
    toast("You left the group.");
  } catch (error) {
    toast("Group nahi chhod paye: " + error.message);
  }
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

      const members = [...new Set([
        ...(group.members || []),
        currentUser.id
      ])];

      const { error: updateError } = await supabaseClient
        .from("chats")
        .update({ members })
        .eq("id", group.id);

      if (updateError) throw updateError;

      const { data: membership, error: membershipFindError } =
        await supabaseClient
          .from("group_members")
          .select("user_id")
          .eq("group_id", group.id)
          .eq("user_id", currentUser.id)
          .maybeSingle();

      if (membershipFindError) throw membershipFindError;

      if (!membership) {
        const { error: memberInsertError } = await supabaseClient
          .from("group_members")
          .insert({
            group_id: group.id,
            user_id: currentUser.id
          });

        if (memberInsertError) throw memberInsertError;
      }
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

// ---------- REALTIME ----------
function subscribeRealtime() {
  if (realtimeChannel) {
    supabaseClient.removeChannel(realtimeChannel);
    realtimeChannel = null;
  }

  if (!currentUser) return;

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

      try {
        await refreshData();
      } catch (error) {
        console.error(error);
      }
    })

    .on("postgres_changes", {
      event: "*",
      schema: "public",
      table: "chats"
    }, async () => {
      try {
        await refreshData();
      } catch (error) {
        console.error(error);
      }
    })

    .on("postgres_changes", {
      event: "*",
      schema: "public",
      table: "group_requests",
      filter: "to_user_id=eq." + currentUser.id
    }, async () => {
      try {
        await refreshData();
      } catch (error) {
        console.error(error);
      }
    })

    .on("postgres_changes", {
      event: "*",
      schema: "public",
      table: "group_admins"
    }, async () => {
      try {
        await refreshData();
      } catch (error) {
        console.error(error);
      }
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

    if (!authListener) {
      const { data: listener } = supabaseClient.auth.onAuthStateChange(
        (event, session) => {
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
        }
      );

      authListener = listener.subscription;
    }
  } catch (error) {
    showAuth();
    setAuthMessage(error.message || "Could not connect to Supabase.");
  }
}

startApp();
