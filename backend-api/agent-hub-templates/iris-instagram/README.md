# Iris — Instagram Manager Agent

One OpenClaw agent that runs your Instagram: content calendar, caption drafts, DM and comment reply drafts, trend watching, weekly performance reviews. You talk to her through one channel you connect (WhatsApp recommended).

**Renamable.** Iris is just the default name — she'll ask what you want to call her on first run.

**Iris drafts. You post.** That's the contract. Instagram doesn't like bots, and neither does your audience — so Iris never publishes, never replies, never follows anyone on her own.

## Files

```
~/.openclaw/workspaces/iris-instagram/
├── SOUL.md          # Iris's identity, values, hard limits
├── TOOLS.md         # Operating rules, tools, and workflows
├── BOOTSTRAP.md     # First-run brand readback and setup checks
├── BRAND.md         # YOUR brand voice, audience, visual rules ← fill this in
├── HEARTBEAT.md     # Scheduled tasks (daily/weekly/monthly)
├── MEMORY.md        # Long-term memory, starts empty
├── calendar/        # Weekly content plans (auto-created)
├── drafts/          # DM and comment reply drafts (auto-created)
├── trends/          # Daily trend scan notes (auto-created)
└── memory/          # Daily notes + performance logs (auto-created)

~/.openclaw/openclaw.json    # Main config (routing, skills, security)
```

## Setup

Full walkthrough with screenshots: **[Iris setup guide](https://docs.norafleet.ai/guides/iris-instagram)**.

### 1. Install Iris from Agent Hub

Install the **Iris Instagram Manager** listing into a workspace. Nora materializes the agent and its files for you.

### 2. Connect Instagram — Integrations tab

Open the agent → **Integrations** tab → connect **Instagram Graph**. It uses an Access Token + Business Account ID (form-based), and requires a **Creator or Business** account linked to a Facebook Page — not a Personal account. Without it, Iris can't pull analytics ([setup guide](https://docs.norafleet.ai/guides/integrations/instagram)).

### 3. Connect one channel — Channels tab

Open the agent → **Channels** tab → connect **one** way for Iris to reach you (you only need one):

- **WhatsApp** (recommended) - use Nora's **Link** action and scan the QR/pairing prompt.
- Or **Telegram**, **Slack**, **Discord**, or another OpenClaw catalog channel.

See the [channels guide](https://docs.norafleet.ai/guides/channels) for the per-channel fields.

### 4. Say hi

Start the runtime and send a first message. Iris introduces herself and what she does, offers to rename, helps you connect anything still missing, then walks you through `BRAND.md` — the single most important step. Without a real brand file she writes generic captions, so spend the 15 minutes here.

> **How integrations reach Iris:** when you connect Instagram Graph, Nora automatically writes `integrations/NORA_INTEGRATIONS.md` into the workspace and updates `TOOLS.md` — you never edit those. Iris reads that list to know what's connected.

## The Honest Constraints

A few things worth knowing before you run this:

**Instagram's API is restrictive by design.** The Graph API gives you insights, comment reads, and scheduled publishing via the Content Publishing API — but Stories, Reels publishing, DMs, and most engagement actions are either limited or heavily rate-limited. Some workflows will require you to do the final step in the Instagram app.

**Meta Business Suite is your friend.** The easiest working pattern: Iris drafts the caption, hashtags, and visual brief; you upload the asset to Meta Business Suite and schedule it there. The Graph API path is available but brittle for a solo operator.

**DM automation is mostly off-limits.** Meta's rules and the Graph API restrict automated DM replies to specific use cases (e.g. Messenger for business). For a creator or small-brand account, Iris drafting DMs for you to send manually is the safe and compliant path.

**Don't enable any "growth" skills.** Auto-follow, auto-like, auto-comment, engagement pods — these get accounts action-blocked or shadowbanned. The `deniedSkills` list in `openclaw.json` blocks them on purpose. Keep it that way.

## First Week

- **Day 1:** Fill in `BRAND.md`. Message Iris "read my brand file and tell me back what you understood." Correct any drift in her read.
- **Day 2–3:** Ask her to draft 3 captions for posts you've already published. Compare to the real ones. Tune BRAND.md where she's off.
- **Day 4:** Ask for a week plan. Approve or edit.
- **Day 5:** Let her draft the actual posts from the approved plan. You finalize and post.
- **Day 7:** Read her first weekly review. See if her reads match your gut.

Iris gets meaningfully better in week 2–3 as she starts building real memory from what works on your account. The first week will feel generic. That's expected.

## Tuning

- If her captions feel off-voice → BRAND.md needs more "do sound like / do not sound like" examples.
- If her trend picks don't fit → add banned topics or styles to BRAND.md's "Hard Nos."
- If she interrupts you too often → trim HEARTBEAT.md conditional triggers or raise the thresholds.
- If her hook suggestions are boring → raise temperature in `openclaw.json` from 0.6 → 0.75.
