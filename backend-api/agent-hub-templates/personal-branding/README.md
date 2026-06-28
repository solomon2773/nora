# Echo — Personal Branding Agent for X & LinkedIn

One agent that helps you ghostwrite for yourself on X and LinkedIn. Learns your voice from real samples, drafts posts and replies in it, tracks what works, and can publish approved original posts through your connected account.

**Renamable.** Echo is just the default — the agent will ask what you want to call it during bootstrap.

## What's Different About This One

- **Bootstrap flow:** first time you message the agent, it runs a guided 15-minute setup over chat. You don't edit markdown files by hand — the agent asks questions, you answer, it writes the files.
- **Voice training:** you paste 5+ of your real writings (posts, emails, texts). The agent extracts your patterns into `VOICE.md` and references it on every draft.
- **Pick one platform or both:** manage X only, LinkedIn only, or both. Your choice cascades through everything — a LinkedIn-only operator never gets X drafts, scans, or heartbeats.
- **Platform-aware:** knows the X vs. LinkedIn playbooks are different and adapts format without losing your voice.
- **Approval-gated publishing:** zero auto-publishing, zero auto-engagement. The agent drafts, you approve final text, then it can publish the approved original post through X or LinkedIn.
- **Channel-flexible:** bootstrap walks you through connecting one channel (WhatsApp recommended) so the agent can reach you.

## Files

```
~/.openclaw/workspaces/echo-personal-brand/
├── SOUL.md          # Agent's identity (it's a ghostwriter, not a personality)
├── TOOLS.md         # Operating rules, tools, and workflows
├── BOOTSTRAP.md     # The first-run onboarding script ← agent runs this automatically
├── PROFILE.md       # YOUR info (filled by bootstrap)
├── VOICE.md         # How you sound (built by bootstrap)
├── PLATFORMS.md     # X vs. LinkedIn playbooks
├── HEARTBEAT.md     # Scheduled tasks
├── MEMORY.md        # Long-term memory (starts empty)
├── calendar/        # Weekly content plans (auto-created)
├── drafts/          # Engagement drafts (auto-created)
├── listening/       # Daily niche listening notes (auto-created)
└── memory/          # Daily notes + performance logs (auto-created)

~/.openclaw/openclaw.json    # Main config
```

## Setup

Full walkthrough with screenshots: **[Echo setup guide](https://noradocs.solomontsao.com/guides/echo-personal-branding)**.

### 1. Install Echo from Agent Hub

Install the **Echo Personal Branding** listing into a workspace. Nora materializes the agent and its files for you — you don't copy markdown by hand.

### 2. Connect your platform(s) — Integrations tab

Open the agent → **Integrations** tab. Connect the platform(s) you want to manage (at least one):

- **Twitter / X** — click _Authorize with X_. Requires an X OAuth 2.0 app ([setup guide](https://noradocs.solomontsao.com/guides/integrations/twitter)).
- **LinkedIn** — click _Authorize with LinkedIn_. Requires a LinkedIn developer app ([setup guide](https://noradocs.solomontsao.com/guides/integrations/linkedin)).

You can start with just one and add the other later.

### 3. Connect one channel — Channels tab

Open the agent → **Channels** tab and connect **at least one** way for Echo to reach you (you only need one):

- **WhatsApp** (recommended) - use Nora's **Link** action and scan the QR/pairing prompt.
- Or **Telegram**, **Slack**, **Discord**, or another OpenClaw catalog channel.

See the [channels guide](https://noradocs.solomontsao.com/guides/channels) for the per-channel fields.

### 4. Say hi

Start the runtime and send your first message ("hey" works). Echo introduces herself and what she does, then runs the bootstrap flow — picks your platform(s), learns your voice from samples, and calibrates. 15–20 minutes and you're live.

> **How integrations reach Echo:** when you connect X or LinkedIn in the Integrations tab, Nora automatically writes `integrations/NORA_INTEGRATIONS.md` into the workspace and updates `TOOLS.md` — you never edit those files. Echo reads that list to know what's connected.

## What the Bootstrap Covers

1. Echo introduces herself and what she can do, then asks what to call her
2. Your name and what you want to be called
3. What you do and want to be known for
4. **Pick your platform(s)** — X only, LinkedIn only, or both (handles collected only for what you choose)
5. Your goals (audience, clients, job, launch, learning, other)
6. **Voice samples** — paste 5+ real writings so the agent learns how you actually sound
7. Posting cadence preferences (for your enabled platform(s))
8. Hard nos — topics you'll never post about
9. Connect a channel so Echo can reach you (WhatsApp walkthrough, or another option)
10. Test draft — try a post to calibrate voice, give feedback
11. Wrap up — you're live

You can bail halfway through and resume later. You can also re-run bootstrap anytime with the command "rebootstrap."

## What You Do Day-to-Day

**Morning:** Agent sends a brief. 4–5 bullets. Anything notable from overnight, today's schedule, one content idea.

**When you want to post:** Tell the agent what you're thinking. It drafts 2–3 variants with different angles. You pick or edit one, approve the final text, and Echo posts it through the connected platform.

**When you want to reply to something:** Forward or describe it. Agent drafts a reply. You send.

**When you want to know what's working:** "Weekly review." Agent tells you what performed and why.

**When you feel the voice drifting:** "Retrain voice." Paste 5+ new samples. Agent updates VOICE.md.

## The Guardrails That Matter

Echo can publish only after explicit approval on the final text in the current conversation. Approval of a topic, outline, or earlier variant is not enough.

Approved publishing is limited to original X or LinkedIn posts on platforms you enabled in bootstrap and connected in the Integrations tab. Replies, DMs, follows, likes, reposts, connection actions, profile edits, and scheduling remain draft/recommend-only.

**This is the point.** The agent can remove the paste-and-post chore without turning personal branding into unsupervised automation. Your review stays in the loop; Echo handles the final platform call after approval.

## Honest Limits

- **X API (X-only concern):** the free tier gives very limited read access. Analytics pulls work with Premium API ($100/mo) or by scraping your own analytics dashboard.
- **LinkedIn API (LinkedIn-only concern):** restrictive. Most people fall back to semi-manual analytics (operator pastes screenshots, agent parses).
- **If the API is unavailable for your platform:** the agent still works for drafting, but analytics pulls and approval-gated posting stay unavailable. You paste your numbers during the weekly review and publish manually.
- **Credential setup:** platform providers (X, LinkedIn) connect from the **Integrations** tab; your channel (WhatsApp, etc.) connects from the **Channels** tab. Never put secrets in the template files.

## First Week Expectations

- **Day 1:** Bootstrap. Do one test draft. It'll be 70% right.
- **Day 2–3:** Ask for drafts on real topics. Correct them. Tell the agent what felt off. It learns fast.
- **Day 4–5:** Voice should feel much closer. Start using drafts for real posts.
- **Day 7:** First weekly review. See if the agent's reads match your gut.
- **Week 2–3:** This is when it gets good. Enough memory, enough calibration.

If week 1 feels too generic, the usual fix is: more voice samples, more specific hard nos, more feedback when a draft is off.

## Customization

- **Rename the agent:** during bootstrap, or anytime edit `PROFILE.md` → `agent_name`.
- **Change cadence:** "update my cadence — X daily, LinkedIn 2x week"
- **Add a platform later:** started X-only or LinkedIn-only? Say "add LinkedIn" / "add X" anytime — Echo walks you through connecting it and turns on its workflows. (Echo covers X and LinkedIn only; for IG, see the Iris IG agent.)
- **Tighten or loosen voice:** retrain anytime.
- **Adjust HEARTBEAT:** edit HEARTBEAT.md directly or ask the agent to draft changes.
