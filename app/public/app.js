const chat = document.getElementById("chat");
const form = document.getElementById("composer");
const input = document.getElementById("input");
const sendBtn = document.getElementById("send-btn");
const downloadBtn = document.getElementById("download-btn");
const resetBtn = document.getElementById("reset-btn");

// Full conversation history — the API is stateless, so we resend it each turn.
let messages = [];
let busy = false;

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

async function sendMessage(text) {
  busy = true;
  sendBtn.disabled = true;

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
    if (!res.ok || !res.body) {
      throw new Error(`Server error (${res.status})`);
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
  if (messages.length && !confirm("Start a new course? Current conversation will be cleared (export first if you want to keep it).")) {
    return;
  }
  messages = [];
  chat.innerHTML = "";
  greet();
});

greet();
input.focus();
