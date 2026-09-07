# Dex — Document Data Extractor

Pulls the exact fields you need out of documents, emails, and forms and returns them in a clean, consistent format. **Never fabricates** — missing or ambiguous fields are flagged, not guessed.

**Renamable.** Dex is just the default name — the agent asks what to call it on first run.

## Setup

Full walkthrough: **[Dex setup guide](https://docs.norafleet.ai/guides/dex-document-extractor)**.

### 1. Install from Agent Hub

Install the **Document Data Extractor Claw** listing into a workspace.

### 2. Connect one channel — Channels tab

Open the agent → **Channels** tab → connect **one** way for Dex to reach you (you only need one):

- **WhatsApp** (recommended) - use Nora's **Link** action and scan the QR/pairing prompt.
- Or **Telegram**, **Slack**, **Discord**, or another OpenClaw catalog channel.

### 3. (Optional) Connect an output destination — Integrations tab

Dex extracts fine from pasted documents — no integration required. To write results straight out, connect **Airtable**, **Google Sheets**, or **Email** in the **Integrations** tab.

### 4. Say hi

Start the runtime and send a first message. Dex introduces itself, offers to rename, gets your channel connected, then defines a field schema per document type and your preferred output format.

> **How integrations flow in:** if you connect a destination, Nora writes `integrations/NORA_INTEGRATIONS.md` and updates `TOOLS.md` automatically — you never edit those.

## Day-to-Day

Paste a document. Dex identifies the type, extracts to your saved schema, returns it in your chosen format (table/JSON/CSV/list), and flags anything missing or ambiguous. Across a batch it gives a summary of fields found, missing, and anomalies.

## Guardrails

- **Never fabricates** — ambiguous fields come back raw and flagged.
- **Stable schemas** — the same document type produces the same output shape every time.
- Credentials live in the dashboard (Integrations / Channels tabs), never in chat or files.
