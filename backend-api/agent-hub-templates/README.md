# Nora Agent Hub Templates

Built-in agent templates available on the Nora Agent Hub. Each template is a ready-to-use OpenClaw agent designed around a common, recurring problem that small businesses and solo developers deal with regularly.

Every template follows the same structure: a set of markdown files that define the agent's identity, behavior, memory, and working style. Templates can be used as-is or customized to fit a specific context.

Credentials are not part of an Agent Hub template. When a preset needs provider access, connect that provider from the installed agent's Integrations tab so Nora stores and syncs the secret material outside the template files.

---

## Templates

### Customer Support & FAQ Claw

**Category:** Support

Most support queues are dominated by the same questions — pricing, how something works, refund policies, account issues. The answers are known; the problem is the time it takes to write them out for every person who asks.

The Customer Support & FAQ Claw handles tier-1 support work. It takes a business's FAQ docs, help articles, and policies as its knowledge base, then drafts responses to incoming customer inquiries. Each message is classified by type (question, complaint, refund request, bug report), matched against the knowledge base, and returned as a ready-to-send draft. Anything it cannot confidently resolve is flagged for human review rather than guessed at. Renamable on first run (default **Remy**); talks to you through one channel you connect (WhatsApp recommended). Full setup walkthrough: [Remy setup guide](https://noradocs.solomontsao.com/guides/remy-customer-support).

**Good for:** SaaS products, e-commerce stores, service businesses, and anyone handling customer inquiries over email or chat.

---

### Lead Outreach Drafter Claw

**Category:** Sales

Cold outreach is time-consuming, and generic messages get ignored. The difference between a message that gets a reply and one that gets deleted is usually whether it reflects any genuine understanding of the recipient.

The Lead Outreach Drafter Claw takes prospect information — role, company, recent activity, or any other available context — and writes a personalized first-touch message grounded in that detail. It also produces a two- to three-step follow-up sequence for prospects who don't respond. Before writing anything, it assesses whether the prospect fits the defined ideal customer profile, so effort isn't spent drafting outreach for people who aren't a good match. Renamable on first run (default **Scout**); talks to you through one channel you connect (WhatsApp recommended). Full setup walkthrough: [Scout setup guide](https://noradocs.solomontsao.com/guides/scout-lead-outreach).

**Good for:** Freelancers pitching new clients, founders doing early sales, consultants growing their pipeline, and anyone doing B2B outreach without a dedicated sales team.

---

### Invoice Follow-Up Claw

**Category:** Finance

Late invoices are one of the most common cash flow problems for small businesses and freelancers. Following up is uncomfortable and easy to delay, which makes the problem worse.

The Invoice Follow-Up Claw drafts payment reminder messages calibrated to where an invoice is in the collection timeline — a gentle reminder at 7 days, a firmer notice at 30, a final demand at 60. Tone is adjusted based on the client relationship (long-term vs. new), and invoices that show signs of a dispute are flagged separately so the right approach can be taken before a reminder is sent. Renamable on first run (default **Penny**); talks to you through one channel you connect (WhatsApp recommended). Full setup walkthrough: [Penny setup guide](https://noradocs.solomontsao.com/guides/penny-invoice-followup).

**Good for:** Freelancers, consultants, agencies, and any service business that invoices clients.

---

### Email Nurture Builder Claw

**Category:** Marketing

Email remains one of the highest-ROI channels for small businesses, but building a proper multi-step sequence takes time. The default for most businesses is a single welcome email, then silence — or an irregular newsletter that gets written when someone finds a spare hour.

The Email Nurture Builder Claw builds complete sequences for any stage of the customer journey: onboarding, trial conversion, post-purchase, upsell, win-back, and educational drip. It produces a sequence plan first — email count, cadence, and the goal of each step — then writes each email with a subject line, preview text, body, and a single call to action. Output is formatted to drop directly into any email platform. Renamable on first run (default **Cadence**); talks to you through one channel you connect (WhatsApp recommended). Full setup walkthrough: [Cadence setup guide](https://noradocs.solomontsao.com/guides/cadence-email-nurture).

**Good for:** SaaS founders with a free trial flow, e-commerce stores running cart abandonment or post-purchase sequences, creators and course builders, and anyone using Mailchimp, ConvertKit, Klaviyo, or similar.

---

### Document Data Extractor Claw

**Category:** Operations

A large amount of operational time goes toward reading documents and manually copying information into somewhere else — invoices into spreadsheets, applications into a CRM, contract details into a tracker. It's repetitive, error-prone work.

The Document Data Extractor Claw takes pasted document content — invoices, contracts, intake forms, applications, order confirmations — and extracts the specified fields according to a defined schema. The extraction schema is set up once per document type, and from that point on the agent returns clean, consistently structured output. Missing or ambiguous fields are flagged rather than silently filled in. Output format is configurable: table, JSON, CSV row, or labeled list. Renamable on first run (default **Dex**); talks to you through one channel you connect (WhatsApp recommended). Full setup walkthrough: [Dex setup guide](https://noradocs.solomontsao.com/guides/dex-document-extractor).

**Good for:** Anyone processing a recurring volume of documents by hand — accountants, operations leads, and solo founders handling their own admin.

---

### Client Intelligence & Sales Momentum Claw

**Category:** Sales

Client relationships are built across many conversations over time, and context gets lost between them. When a follow-up finally happens weeks after a promising discussion, it often starts from scratch — what was said, what was promised, and what the next step was supposed to be has faded.

The Client Intelligence & Sales Momentum Claw maintains a living profile for each client based on notes, messages, and conversation recaps fed into it. It tracks what the client needs, what commitments have been made, what the next step is, and whether the opportunity is losing momentum. When follow-up timing approaches, it drafts outreach that picks up the existing thread rather than starting over. Renamable on first run (default **Mercer**); talks to you through one channel you connect (WhatsApp recommended). Full setup walkthrough: [Mercer setup guide](https://noradocs.solomontsao.com/guides/mercer-client-intelligence).

**Good for:** Consultants managing multiple client relationships, account managers, freelancers with several active prospects, and anyone whose business depends on warm relationships staying warm.

---

### Social Media & Market Signal Claw

**Category:** Marketing

Maintaining a consistent social media presence takes time that most small business owners and solo developers don't have. The bottleneck is rarely a lack of things to say — it's the time required to turn a relevant trend or idea into something polished enough to publish.

The Social Media & Market Signal Claw researches trending topics in a defined space, identifies signals worth reacting to, and drafts posts for review. Content is organized by platform (LinkedIn, Instagram, and others). Nothing is published automatically — the agent drafts and stages content, and a human approves before anything goes live. Renamable on first run (default **Signal**); talks to you through one channel you connect (WhatsApp recommended). Full setup walkthrough: [Signal setup guide](https://noradocs.solomontsao.com/guides/signal-market-signal).

**Good for:** Founders and operators building a personal or business brand, and anyone who wants consistent social visibility without spending hours on it each week.

---

### Chief-of-Staff Claw

**Category:** Operations

Ideas and commitments get lost between meetings, chats, and working docs. The bottleneck is rarely effort — it's that work never gets normalized into a clear owner, a next step, and a status everyone can see.

The Chief-of-Staff Claw turns conversations, notes, and updates into owned execution. It captures work, assigns an owner and a next step, tracks movement across pending / active / blocked / waiting / done, and replaces vague check-ins with a crisp status picture — surfacing blockers and unowned work instead of burying them. It keeps internal execution separate from client-facing sales. Renamable on first run (default **Atlas**); talks to you through one channel you connect (WhatsApp recommended). Full setup walkthrough: [Atlas setup guide](https://noradocs.solomontsao.com/guides/atlas-chief-of-staff).

**Good for:** Founders, operations leads, and small internal teams that need accountability and status clarity without heavyweight project-management process.

---

### Communication Intelligence Claw

**Category:** Communication

High-signal messages drown in high-volume chats. Watching every channel is exhausting, but missing a direct ask, a decision, or a deadline is costly.

The Communication Intelligence Claw is a triage filter. It watches the chats you point it at — connected live (Slack, Teams, email) or from imported logs — stays silent by default, and escalates only what matters: direct mentions, real asks, decisions, deadlines, and the topics you care about. Everything else rolls into a short summary. Renamable on first run (default **Sentry**); the chats it monitors are separate from the one channel you connect for it to reach you (WhatsApp recommended). Full setup walkthrough: [Sentry setup guide](https://noradocs.solomontsao.com/guides/sentry-communication-intelligence).

**Good for:** Founders, leaders, and operators in many active chats who want the signal without the noise.

---

### Iris Instagram Manager

**Category:** Marketing

Instagram rewards consistency, strong hooks, and a real understanding of the audience, but most operators do not have time to keep a full content system running every week. The work is not just writing captions; it is planning formats, watching trends, tracking performance, and keeping reply drafts ready without sliding into bot-like engagement.

Iris Instagram Manager is a single-account Instagram operator built around that workflow. It reads the brand rules, plans a weekly calendar, drafts captions and hashtag sets, prepares DM and comment replies for approval, monitors trends, and compiles weekly performance reviews. Publishing stays manual by design, so the operator remains in control of every post, Story, Reel, comment, and DM. Renamable on first run; talks to you through one channel you connect (WhatsApp recommended). Full setup walkthrough: [Iris setup guide](https://noradocs.solomontsao.com/guides/iris-instagram).

**Good for:** Creators, small brands, indie founders, and marketing leads who want a disciplined Instagram drafting workflow without automating risky engagement behavior.

---

### Echo Personal Branding

**Category:** Marketing

Personal branding breaks down when every post sounds generic or the operator cannot keep a steady cadence across platforms. The missing layer is usually not ideas alone; it is a system that remembers how the operator actually sounds, adapts that voice to each platform, and keeps drafts moving without taking over publishing.

Echo Personal Branding is a ghostwriting-oriented preset for X and LinkedIn. It runs a bootstrap flow, builds `VOICE.md` from real writing samples, tracks what lands, drafts multiple post angles, prepares engagement replies for review, and keeps platform-specific playbooks close to the daily workflow. The operator approves final text every time; Echo can then publish original posts through connected X/LinkedIn integrations. Manage **X, LinkedIn, or both** — the platform you pick during bootstrap drives every workflow. Full setup walkthrough: [Echo setup guide](https://noradocs.solomontsao.com/guides/echo-personal-branding).

**Good for:** Founders, consultants, engineers, and operators building a public voice on X, LinkedIn, or both while keeping every post approval-gated.
