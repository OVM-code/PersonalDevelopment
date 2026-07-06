# CourseCraft — the app

A small web chat app that turns any book into a personalized learning journey.
It wraps the [CourseCraft prompt](../prompts/book-to-course-prompt.md) around the
Claude API: the assistant interviews you about the book, your goals, and how you
learn, then builds the course module by module with all assets (lessons, concept
maps, quizzes, flashcards, audio scripts, spaced-repetition schedule…).

## Setup

You need [Node.js](https://nodejs.org) 18+ and an Anthropic API key
(create one at [console.anthropic.com](https://console.anthropic.com) → API Keys).

```bash
cd app
npm install
cp .env.example .env      # then edit .env and paste your API key
npm start
```

Open http://localhost:3000 and start chatting.

## Features

- **Streaming responses** — text appears as Claude writes it.
- **Prompt caching** — the large CourseCraft system prompt is cached server-side,
  so follow-up turns cost ~90% less on the cached portion.
- **Export** — download the whole session as a Markdown file (works great pasted
  into Notion/Obsidian).
- **New course** — reset the conversation to start another book.

## Configuration (`.env`)

| Variable | Default | Description |
|---|---|---|
| `ANTHROPIC_API_KEY` | — | Required. Your Anthropic API key. |
| `MODEL` | `claude-sonnet-5` | Claude model to use. |
| `PORT` | `3000` | HTTP port. |

## How it works

- `server.js` — Express server. Serves the static UI and exposes `POST /api/chat`,
  which forwards the conversation to the Claude Messages API and streams the reply
  back to the browser as Server-Sent Events. The system prompt is read from
  `../prompts/book-to-course-prompt.md` (single source of truth) with a
  `cache_control` breakpoint for prompt caching.
- `public/` — vanilla HTML/CSS/JS chat interface, no build step.

The conversation history lives in the browser; the server is stateless.
