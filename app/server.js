import "dotenv/config";
import express from "express";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import Anthropic from "@anthropic-ai/sdk";

const here = path.dirname(fileURLToPath(import.meta.url));

// The CourseCraft prompt lives in the repo's prompts/ folder — single source of truth.
const SYSTEM_PROMPT = fs.readFileSync(
  path.join(here, "..", "prompts", "book-to-course-prompt.md"),
  "utf-8",
);

// The user asked for Sonnet; override with MODEL in .env if desired.
const MODEL = process.env.MODEL || "claude-sonnet-5";

const client = new Anthropic();
const app = express();

app.use(express.json({ limit: "10mb" }));
app.use(express.static(path.join(here, "public")));

app.post("/api/chat", async (req, res) => {
  const { messages } = req.body;
  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: "messages array required" });
  }

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  const send = (event, data) =>
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

  if (!process.env.ANTHROPIC_API_KEY) {
    send("error", {
      message:
        "No API key configured. Copy app/.env.example to app/.env, add your ANTHROPIC_API_KEY (from console.anthropic.com), and restart the server.",
    });
    return res.end();
  }

  try {
    const stream = client.messages.stream({
      model: MODEL,
      max_tokens: 64000,
      // Frozen system prompt with a cache breakpoint: every request after the
      // first reads the large CourseCraft prompt from cache (~0.1x input cost).
      system: [
        {
          type: "text",
          text: SYSTEM_PROMPT,
          cache_control: { type: "ephemeral" },
        },
      ],
      messages,
    });

    stream.on("text", (delta) => send("delta", { text: delta }));

    const final = await stream.finalMessage();
    send("done", {
      stop_reason: final.stop_reason,
      usage: {
        input_tokens: final.usage.input_tokens,
        output_tokens: final.usage.output_tokens,
        cache_read_input_tokens: final.usage.cache_read_input_tokens,
      },
    });
  } catch (err) {
    if (err instanceof Anthropic.AuthenticationError) {
      send("error", {
        message:
          "Invalid or missing API key. Set ANTHROPIC_API_KEY in app/.env (get a key at console.anthropic.com).",
      });
    } else if (err instanceof Anthropic.RateLimitError) {
      send("error", { message: "Rate limited — wait a moment and try again." });
    } else if (err instanceof Anthropic.APIError) {
      send("error", { message: `API error ${err.status}: ${err.message}` });
    } else {
      send("error", { message: `Unexpected error: ${err.message}` });
    }
  } finally {
    res.end();
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`CourseCraft running at http://localhost:${PORT} (model: ${MODEL})`);
  if (!process.env.ANTHROPIC_API_KEY) {
    console.warn(
      "⚠ ANTHROPIC_API_KEY is not set — copy .env.example to .env and add your key.",
    );
  }
});
