// Require an active session; bounce to login otherwise.
fetch("/api/me")
  .then(async (r) => {
    if (r.status === 401) return (location.href = "/login");
    if (r.status === 403) {
      alert("Your subscription is no longer active. Please resubscribe to continue.");
      return (location.href = "/#pricing");
    }
    const me = await r.json();
    document.getElementById("user-info").textContent =
      `${me.email} · ${me.usagePercent}% of monthly fair-use`;
  })
  .catch(() => {});

document.getElementById("logout-btn").addEventListener("click", async () => {
  await fetch("/api/logout", { method: "POST" });
  location.href = "/";
});

const chat = document.getElementById("chat");
const form = document.getElementById("composer");
const input = document.getElementById("input");
const sendBtn = document.getElementById("send-btn");
const downloadBtn = document.getElementById("download-btn");
const resetBtn = document.getElementById("reset-btn");
const coursesBtn = document.getElementById("courses-btn");
const coursesPanel = document.getElementById("courses-panel");
const coursesList = document.getElementById("courses-list");
const coursesEmpty = document.getElementById("courses-empty");
const coursesCloseBtn = document.getElementById("courses-close-btn");

// Full conversation history — the API is stateless, so we resend it each turn.
let messages = [];
let busy = false;
// Server-side course this conversation is saved as. Created lazily on first
// send, so browsing around doesn't litter the account with empty courses.
let currentCourseId = null;

function addBubble(role, text = "") {
  const div = document.createElement("div");
  div.className = `msg ${role}`;
  div.textContent = text;
  chat.appendChild(div);
  chat.scrollTop = chat.scrollHeight;
  return div;
}

function greet() {
  addBubble(
    "assistant",
    "Hi! I'm CourseCraft. Tell me which book you'd like to turn into a course — " +
      "title and author is enough to start (or paste chapters for best results). " +
      "I'll interview you about your goals and how you learn, then build the journey step by step.",
  );
}

function deriveTitle(firstUserMessage) {
  const oneLine = firstUserMessage.replace(/\s+/g, " ").trim();
  return oneLine.length > 60 ? oneLine.slice(0, 60) + "…" : oneLine || "Untitled course";
}

async function saveCurrentCourse() {
  if (!currentCourseId) return;
  try {
    await fetch(`/api/courses/${currentCourseId}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages }),
    });
  } catch {
    // Best-effort autosave — a failed save shouldn't interrupt the chat.
  }
}

async function ensureCourseCreated(firstUserMessage) {
  if (currentCourseId) return;
  try {
    const res = await fetch("/api/courses", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: deriveTitle(firstUserMessage) }),
    });
    if (res.ok) {
      const course = await res.json();
      currentCourseId = course.id;
    }
  } catch {
    // If this fails, the conversation still works — it just won't be saved.
  }
}

async function sendMessage(text) {
  busy = true;
  sendBtn.disabled = true;

  await ensureCourseCreated(messages.length ? messages[0].content : text);

  messages.push({ role: "user", content: text });
  addBubble("user", text);
  const bubble = addBubble("assistant");
  bubble.classList.add("thinking");
  bubble.textContent = "…";

  let assistantText = "";
  let firstDelta = true;

  try {
    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages }),
    });
    if (res.status === 401) {
      location.href = "/login";
      return;
    }
    if (!res.ok || !res.body) {
      let detail = `Server error (${res.status})`;
      try {
        const j = await res.json();
        if (j.error) detail = j.error;
      } catch {}
      throw new Error(detail);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      // Parse complete SSE events out of the buffer
      let sep;
      while ((sep = buffer.indexOf("\n\n")) !== -1) {
        const raw = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);

        let event = "message";
        let data = "";
        for (const line of raw.split("\n")) {
          if (line.startsWith("event: ")) event = line.slice(7);
          else if (line.startsWith("data: ")) data += line.slice(6);
        }
        if (!data) continue;
        const payload = JSON.parse(data);

        if (event === "delta") {
          if (firstDelta) {
            bubble.classList.remove("thinking");
            bubble.textContent = "";
            firstDelta = false;
          }
          assistantText += payload.text;
          bubble.textContent = assistantText;
          chat.scrollTop = chat.scrollHeight;
        } else if (event === "error") {
          bubble.classList.remove("thinking");
          bubble.classList.add("error");
          bubble.textContent = payload.message;
        }
      }
    }
  } catch (err) {
    bubble.classList.remove("thinking");
    bubble.classList.add("error");
    bubble.textContent = `Connection error: ${err.message}`;
  }

  if (assistantText) {
    messages.push({ role: "assistant", content: assistantText });
    saveCurrentCourse();
  } else {
    // Failed turn — drop the user message so history stays consistent for retry
    messages.pop();
  }

  busy = false;
  sendBtn.disabled = false;
  input.focus();
}

form.addEventListener("submit", (e) => {
  e.preventDefault();
  const text = input.value.trim();
  if (!text || busy) return;
  input.value = "";
  sendMessage(text);
});

input.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    form.requestSubmit();
  }
});

downloadBtn.addEventListener("click", () => {
  const md = messages
    .map((m) => `## ${m.role === "user" ? "You" : "CourseCraft"}\n\n${m.content}`)
    .join("\n\n---\n\n");
  const blob = new Blob([`# CourseCraft Session\n\n${md}\n`], {
    type: "text/markdown",
  });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "coursecraft-session.md";
  a.click();
  URL.revokeObjectURL(a.href);
});

resetBtn.addEventListener("click", () => {
  if (messages.length && !confirm("Start a new course? Your current one is already saved — find it later under “My courses”.")) {
    return;
  }
  messages = [];
  currentCourseId = null;
  chat.innerHTML = "";
  greet();
});

// ---------------------------------------------------------------------------
// My courses panel — load, resume, delete
// ---------------------------------------------------------------------------

function formatDate(iso) {
  return new Date(iso.replace(" ", "T") + "Z").toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

async function openCoursesPanel() {
  coursesPanel.hidden = false;
  coursesList.innerHTML = "";
  coursesEmpty.hidden = true;

  const res = await fetch("/api/courses");
  if (!res.ok) return;
  const courses = await res.json();

  if (courses.length === 0) {
    coursesEmpty.hidden = false;
    return;
  }

  for (const course of courses) {
    const li = document.createElement("li");
    li.className = "course-item";

    const info = document.createElement("div");
    info.className = "course-info";
    const title = document.createElement("div");
    title.className = "course-title";
    title.textContent = course.title;
    const meta = document.createElement("div");
    meta.className = "course-meta";
    meta.textContent = `Updated ${formatDate(course.updated_at)}`;
    info.append(title, meta);

    const actions = document.createElement("div");
    actions.className = "course-actions";

    const resumeBtn = document.createElement("button");
    resumeBtn.textContent = "Resume";
    resumeBtn.addEventListener("click", () => resumeCourse(course.id));

    const deleteBtn = document.createElement("button");
    deleteBtn.textContent = "Delete";
    deleteBtn.className = "danger";
    deleteBtn.addEventListener("click", async (e) => {
      e.stopPropagation();
      if (!confirm(`Delete "${course.title}"? This can't be undone.`)) return;
      await fetch(`/api/courses/${course.id}`, { method: "DELETE" });
      if (currentCourseId === course.id) {
        messages = [];
        currentCourseId = null;
        chat.innerHTML = "";
        greet();
      }
      openCoursesPanel();
    });

    actions.append(resumeBtn, deleteBtn);
    li.append(info, actions);
    coursesList.appendChild(li);
  }
}

async function resumeCourse(id) {
  const res = await fetch(`/api/courses/${id}`);
  if (!res.ok) return;
  const course = await res.json();

  messages = course.messages;
  currentCourseId = course.id;
  chat.innerHTML = "";
  for (const m of messages) addBubble(m.role, m.content);
  coursesPanel.hidden = true;
  input.focus();
}

coursesBtn.addEventListener("click", openCoursesPanel);
coursesCloseBtn.addEventListener("click", () => (coursesPanel.hidden = true));
coursesPanel.addEventListener("click", (e) => {
  if (e.target === coursesPanel) coursesPanel.hidden = true;
});

greet();
input.focus();
