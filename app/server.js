import "dotenv/config";
import express from "express";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { fileURLToPath } from "url";
import Anthropic from "@anthropic-ai/sdk";
import {
  upsertUser,
  getUserByEmail,
  setUserStatus,
  createSession,
  getSession,
  deleteSession,
  getMonthlyUsage,
  addUsage,
} from "./db.js";

const here = path.dirname(fileURLToPath(import.meta.url));

// The CourseCraft prompt lives in the repo's prompts/ folder — single source of truth.
const SYSTEM_PROMPT = fs.readFileSync(
  path.join(here, "..", "prompts", "book-to-course-prompt.md"),
  "utf-8",
);

const MODEL = process.env.MODEL || "claude-sonnet-5";
// Sonnet 5 pricing in micro-USD per token ($3/M input, $15/M output)
const INPUT_MICROUSD_PER_TOKEN = 3;
const OUTPUT_MICROUSD_PER_TOKEN = 15;
// Per-customer monthly API cost budget (USD). Protects your margin.
const MONTHLY_COST_CAP_USD = Number(process.env.MONTHLY_COST_CAP_USD || 5);

const LS_WEBHOOK_SECRET = process.env.LEMONSQUEEZY_WEBHOOK_SECRET || "";
const LS_CHECKOUT_URL = process.env.LEMONSQUEEZY_CHECKOUT_URL || "";
// Dev-only backdoor for testing before Lemon Squeezy is set up.
const DEV_ACCESS_CODE = process.env.DEV_ACCESS_CODE || "";

const client = new Anthropic();
const app = express();

// ---------------------------------------------------------------------------
// Lemon Squeezy webhook — raw body needed for HMAC verification, so register
// it BEFORE express.json().
// ---------------------------------------------------------------------------
app.post(
  "/api/webhooks/lemonsqueezy",
  express.raw({ type: "application/json" }),
  (req, res) => {
    if (!LS_WEBHOOK_SECRET) return res.status(503).send("webhook not configured");

    const signature = req.get("X-Signature") || "";
    const digest = crypto
      .createHmac("sha256", LS_WEBHOOK_SECRET)
      .update(req.body)
      .digest("hex");
    const sigBuf = Buffer.from(signature, "hex");
    const digBuf = Buffer.from(digest, "hex");
    if (sigBuf.length !== digBuf.length || !crypto.timingSafeEqual(sigBuf, digBuf)) {
      return res.status(401).send("invalid signature");
    }

    const payload = JSON.parse(req.body.toString("utf-8"));
    const event = payload.meta?.event_name;
    const attrs = payload.data?.attributes || {};
    const email = attrs.user_email || attrs.customer_email;
    if (!email) return res.status(200).send("ok (no email)");

    const activeStates = ["active", "on_trial", "past_due"];
    if (event === "subscription_created" || event === "subscription_resumed" ||
        event === "subscription_unpaused" ||
        (event === "subscription_updated" && activeStates.includes(attrs.status))) {
      upsertUser(email, { status: "active" });
    } else if (
      event === "subscription_cancelled" ||
      event === "subscription_expired" ||
      event === "subscription_paused" ||
      (event === "subscription_updated" && !activeStates.includes(attrs.status))
    ) {
      // Cancelled subs stay usable until period end; LS sends expired when it truly ends
      const status = event === "subscription_cancelled" ? "active" : "inactive";
      if (getUserByEmail(email)) setUserStatus(email, status);
    }
    res.status(200).send("ok");
  },
);

app.use(express.json({ limit: "10mb" }));
app.use(express.static(path.join(here, "public")));

// ---------------------------------------------------------------------------
// Auth helpers
// ---------------------------------------------------------------------------
function getSessionFromReq(req) {
  const cookie = req.get("Cookie") || "";
  const match = cookie.match(/(?:^|;\s*)cc_session=([a-f0-9]{64})/);
  return match ? getSession(match[1]) : null;
}

function requireAuth(req, res, next) {
  const session = getSessionFromReq(req);
  if (!session) return res.status(401).json({ error: "not_authenticated" });
  if (session.status !== "active") {
    return res.status(403).json({ error: "subscription_inactive" });
  }
  req.session = session;
  next();
}

function setSessionCookie(res, token) {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  res.setHeader(
    "Set-Cookie",
    `cc_session=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${30 * 24 * 3600}${secure}`,
  );
}

// ---------------------------------------------------------------------------
// Public config for the landing/login pages
// ---------------------------------------------------------------------------
app.get("/api/config", (_req, res) => {
  res.json({ checkoutUrl: LS_CHECKOUT_URL });
});

// ---------------------------------------------------------------------------
// Login with a Lemon Squeezy license key (issued automatically on purchase)
// ---------------------------------------------------------------------------
app.post("/api/login", async (req, res) => {
  const licenseKey = (req.body.licenseKey || "").trim();
  if (!licenseKey) return res.status(400).json({ error: "license key required" });

  // Dev backdoor for local testing before Lemon Squeezy exists
  if (DEV_ACCESS_CODE && licenseKey === DEV_ACCESS_CODE) {
    const user = upsertUser("dev@localhost", { status: "active" });
    const token = crypto.randomBytes(32).toString("hex");
    createSession(token, user.id);
    setSessionCookie(res, token);
    return res.json({ email: user.email });
  }

  try {
    const lsRes = await fetch("https://api.lemonsqueezy.com/v1/licenses/validate", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ license_key: licenseKey }),
    });
    const data = await lsRes.json();

    const keyStatus = data.license_key?.status;
    if (!data.valid && keyStatus !== "inactive") {
      return res.status(401).json({ error: "This license key is not valid or has expired." });
    }
    const email = data.meta?.customer_email;
    if (!email) {
      return res.status(401).json({ error: "Could not resolve the customer for this key." });
    }

    // Trust Lemon Squeezy as the source of truth at login time
    const user = upsertUser(email, { licenseKey, status: "active" });
    const token = crypto.randomBytes(32).toString("hex");
    createSession(token, user.id);
    setSessionCookie(res, token);
    res.json({ email: user.email });
  } catch (err) {
    res.status(502).json({ error: `Could not reach the license server: ${err.message}` });
  }
});

app.post("/api/logout", (req, res) => {
  const session = getSessionFromReq(req);
  if (session) deleteSession(session.token);
  res.setHeader("Set-Cookie", "cc_session=; HttpOnly; Path=/; Max-Age=0");
  res.json({ ok: true });
});

app.get("/api/me", requireAuth, (req, res) => {
  const usage = getMonthlyUsage(req.session.user_id);
  const capMicro = MONTHLY_COST_CAP_USD * 1_000_000;
  res.json({
    email: req.session.email,
    usagePercent: Math.min(100, Math.round((usage.cost_microusd / capMicro) * 100)),
  });
});

// ---------------------------------------------------------------------------
// Chat — authenticated + metered
// ---------------------------------------------------------------------------
app.post("/api/chat", requireAuth, async (req, res) => {
  const { messages } = req.body;
  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: "messages array required" });
  }

  const usage = getMonthlyUsage(req.session.user_id);
  if (usage.cost_microusd >= MONTHLY_COST_CAP_USD * 1_000_000) {
    return res.status(429).json({
      error:
        "You've reached this month's fair-use limit. It resets on the 1st — or contact support to raise it.",
    });
  }

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  const send = (event, data) =>
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

  if (!process.env.ANTHROPIC_API_KEY) {
    send("error", { message: "Server misconfigured: no ANTHROPIC_API_KEY set." });
    return res.end();
  }

  try {
    const stream = client.messages.stream({
      model: MODEL,
      max_tokens: 64000,
      // Frozen system prompt with a cache breakpoint: every request after the
      // first reads the large CourseCraft prompt from cache (~0.1x input cost).
      system: [
        { type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } },
      ],
      messages,
    });

    stream.on("text", (delta) => send("delta", { text: delta }));

    const final = await stream.finalMessage();
    const u = final.usage;
    // Cache reads are ~0.1x input price; count them at that rate
    const costMicro = Math.round(
      u.input_tokens * INPUT_MICROUSD_PER_TOKEN +
        (u.cache_creation_input_tokens || 0) * INPUT_MICROUSD_PER_TOKEN * 1.25 +
        (u.cache_read_input_tokens || 0) * INPUT_MICROUSD_PER_TOKEN * 0.1 +
        u.output_tokens * OUTPUT_MICROUSD_PER_TOKEN,
    );
    addUsage(req.session.user_id, u.input_tokens, u.output_tokens, costMicro);

    send("done", { stop_reason: final.stop_reason });
  } catch (err) {
    if (err instanceof Anthropic.RateLimitError) {
      send("error", { message: "The service is busy — wait a moment and try again." });
    } else if (err instanceof Anthropic.APIError) {
      send("error", { message: `Upstream error ${err.status}. Please try again.` });
    } else {
      send("error", { message: `Unexpected error: ${err.message}` });
    }
  } finally {
    res.end();
  }
});

// Pretty routes for the static pages
app.get("/app", (_req, res) => res.sendFile(path.join(here, "public", "app.html")));
app.get("/login", (_req, res) => res.sendFile(path.join(here, "public", "login.html")));
app.get("/terms", (_req, res) => res.sendFile(path.join(here, "public", "terms.html")));
app.get("/privacy", (_req, res) => res.sendFile(path.join(here, "public", "privacy.html")));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`CourseCraft running at http://localhost:${PORT} (model: ${MODEL})`);
  if (!process.env.ANTHROPIC_API_KEY) console.warn("⚠ ANTHROPIC_API_KEY is not set.");
  if (!LS_WEBHOOK_SECRET) console.warn("⚠ LEMONSQUEEZY_WEBHOOK_SECRET is not set — webhooks disabled.");
});
