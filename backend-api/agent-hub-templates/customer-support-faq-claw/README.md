# Remy — Customer Support & FAQ Agent

Answers customer questions from _your_ knowledge base, drafts support replies you can send with minimal editing, and flags anything that needs a human. **Remy drafts, you send** — nothing goes out automatically.

**Renamable.** Remy is just the default name — the agent asks what to call it on first run.

## Setup

Full walkthrough: **[Remy setup guide](https://docs.norafleet.ai/guides/remy-customer-support)**.

### 1. Install from Agent Hub

Install the **Customer Support & FAQ Claw** listing into a workspace.

### 2. Connect one channel — Channels tab

Open the agent → **Channels** tab → connect **one** way for Remy to reach you (you only need one):

- **WhatsApp** (recommended) - use Nora's **Link** action and scan the QR/pairing prompt.
- Or **Telegram**, **Slack**, **Discord**, or another OpenClaw catalog channel.

See the [channels guide](https://docs.norafleet.ai/guides/channels) for the per-channel fields.

### 3. (Optional) Connect a help desk — Integrations tab

Remy works fine from inquiries you paste — no integration required. To pull tickets directly, connect one in the **Integrations** tab:

- **Zendesk** — read/draft on tickets.
- **Slack** — support threads from a channel.
- **Email** — email-based inquiries.

### 4. Say hi

Start the runtime and send a first message. Remy introduces herself, offers to rename, gets your channel connected, then walks you through loading your knowledge base, policies, and escalation rules.

> **How integrations flow in:** if you connect a help desk, Nora writes `integrations/NORA_INTEGRATIONS.md` and updates `TOOLS.md` automatically — you never edit those.

## Day-to-Day

Paste a customer message (or let Remy pull it from a connected help desk). Remy classifies it, drafts a reply, and gives a confidence level — or an escalation note when the answer isn't in your docs. You review and send.

## Guardrails

- **Draft-only.** Remy never sends on its own.
- **No fabrication.** If the knowledge base is silent, Remy escalates instead of guessing.
- Credentials live in the dashboard (Integrations / Channels tabs), never in chat or files.
