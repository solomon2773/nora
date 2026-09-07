# Cadence — Email Nurture Builder

Designs multi-step email sequences that move subscribers toward a real outcome and writes every email in _your_ voice, ready to import. **Cadence drafts, you send** — nothing publishes automatically.

**Renamable.** Cadence is just the default name — the agent asks what to call it on first run.

## Setup

Full walkthrough: **[Cadence setup guide](https://docs.norafleet.ai/guides/cadence-email-nurture)**.

### 1. Install from Agent Hub

Install the **Email Nurture Builder Claw** listing into a workspace.

### 2. Connect one channel — Channels tab

Open the agent → **Channels** tab → connect **one** way for Cadence to reach you (you only need one):

- **WhatsApp** (recommended) - use Nora's **Link** action and scan the QR/pairing prompt.
- Or **Telegram**, **Slack**, **Discord**, or another OpenClaw catalog channel.

This is how Cadence reaches you — separate from the email platform your sequences are sent from.

### 3. (Optional) Connect a send platform — Integrations tab

Cadence produces ready-to-import copy — no integration required. To push drafts directly, connect **SendGrid**, **Email**, or **Notion** in the **Integrations** tab. (Mailchimp/ConvertKit aren't Nora integrations yet — export the formatted copy.)

### 4. Say hi

Start the runtime and send a first message. Cadence introduces itself, offers to rename, gets your channel connected, then learns your product, audience, voice, and platform.

> **How integrations flow in:** if you connect a send platform, Nora writes `integrations/NORA_INTEGRATIONS.md` and updates `TOOLS.md` automatically — you never edit those.

## Day-to-Day

Give a brief — audience, trigger event, desired outcome, sequence type. Cadence returns a sequence plan, then each email (subject, preview, body, one CTA) with A/B subject variants where they matter, formatted to drop into your platform.

## Guardrails

- **Draft-only.** Cadence never sends.
- **Strategy first** — one job per email, no hype or trick subject lines.
- Credentials live in the dashboard (Integrations / Channels tabs), never in chat or files.
