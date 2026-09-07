# Sentry — Communication Intelligence Agent

Watches the chats you point it at, stays quiet on the noise, and surfaces only what needs you — direct mentions, real asks, decisions, deadlines, and topics you care about.

**Renamable.** Sentry is just the default name — the agent asks what to call it on first run.

## Setup

Full walkthrough: **[Sentry setup guide](https://docs.norafleet.ai/guides/sentry-communication-intelligence)**.

### 1. Install from Agent Hub

Install the **Communication Intelligence Claw** listing into a workspace.

### 2. Connect one channel — Channels tab

Open the agent → **Channels** tab → connect **one** way for Sentry to _reach you_ with escalations (you only need one):

- **WhatsApp** (recommended) - use Nora's **Link** action and scan the QR/pairing prompt.
- Or **Telegram**, **Slack**, **Discord**, or another OpenClaw catalog channel.

This is how Sentry reaches you — separate from the chats it monitors.

### 3. Point Sentry at what to watch

Two ways, mix as needed:

- **Live monitoring** — connect a source in the **Integrations** tab (**Slack** or **email**) so Sentry reads it directly.
- **Imported logs** — paste or import chat exports (WhatsApp/WeChat/group logs); no integration required.

### 4. Say hi

Start the runtime and send a first message. Sentry introduces itself, offers to rename, gets your channel connected, then captures the people, channels, topics, and trigger rules that decide when it breaks silence.

> **How integrations flow in:** if you connect a live source, Nora writes `integrations/NORA_INTEGRATIONS.md` and updates `TOOLS.md` automatically — you never edit those.

## Day-to-Day

Sentry stays silent by default. When a trigger fires — you're mentioned, asked, or a watched topic/decision/deadline appears — it escalates with a short "what happened, why it matters, what to do next," and rolls everything else into a summary.

## Guardrails

- **Silence by default** — it filters attention, it doesn't amplify chatter.
- **Grounded** — never fabricates context; flags what still needs confirmation.
- Credentials live in the dashboard (Integrations / Channels tabs), never in chat or files.
