# Penny — Invoice Follow-Up Agent

Drafts personalized payment reminders calibrated to where an invoice sits in the collection timeline, tuned to the client relationship. **Penny drafts, you send** — nothing goes out automatically.

**Renamable.** Penny is just the default name — the agent asks what to call it on first run.

## Setup

Full walkthrough: **[Penny setup guide](https://docs.norafleet.ai/guides/penny-invoice-followup)**.

### 1. Install from Agent Hub

Install the **Invoice Follow-Up Claw** listing into a workspace.

### 2. Connect one channel — Channels tab

Open the agent → **Channels** tab → connect **one** way for Penny to reach you (you only need one):

- **WhatsApp** (recommended) - use Nora's **Link** action and scan the QR/pairing prompt.
- Or **Telegram**, **Slack**, **Discord**, or another OpenClaw catalog channel.

### 3. (Optional) Connect billing — Integrations tab

Penny drafts fine from invoice details you paste — no integration required. To pull invoice/payment status directly, connect **Stripe** or **Email** in the **Integrations** tab. (QuickBooks/Xero aren't available as Nora integrations yet — paste those details in.)

### 4. Say hi

Start the runtime and send a first message. Penny introduces itself, offers to rename, gets your channel connected, then captures your payment terms, tone, and escalation threshold.

> **How integrations flow in:** if you connect billing, Nora writes `integrations/NORA_INTEGRATIONS.md` and updates `TOOLS.md` automatically — you never edit those.

## Day-to-Day

Paste an overdue invoice — client, amount, due date, days overdue, prior contact. Penny classifies the stage, drafts the right reminder (or a full sequence with timing), and flags disputes for a conversation-first approach. You review and send.

## Guardrails

- **Draft-only.** Penny never sends, and never decides write-offs or legal action.
- **No aggressive or shaming messages** — disputes and edge cases escalate to you.
- Credentials live in the dashboard (Integrations / Channels tabs), never in chat or files.
