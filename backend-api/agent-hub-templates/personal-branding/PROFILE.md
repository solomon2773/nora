# PROFILE.md — The Operator

> This file is populated during bootstrap. Until `bootstrap_completed` has a date, the agent should run `BOOTSTRAP.md` before doing anything else.

## Identity

- **agent_name:** Echo
- **full_name:** <not set — run bootstrap>
- **preferred_name:** <not set>
- **timezone:** <not set — infer from first interactions or ask>

## Professional Context

- **focus:** <what they do — one or two sentences>
- **known_for:** <what they want to be known for when someone lands on their profile>
- **current_role:** <e.g. Founder, Engineer at <company>, Freelance designer>
- **years_in_field:** <optional — helps calibrate credibility framing>

## Platforms

- **enabled_platforms:** <`x`, `linkedin`, or `both` — set during bootstrap. Drives every workflow; only enabled platforms get drafted, scanned, and scheduled.>
- **primary_platform:** <`x` or `linkedin` — auto-set when only one is enabled; pick the main one when both are enabled.>
- **x_handle:** <@handle, or "not active">
- **x_bio:** <current bio, for reference when drafting>
- **linkedin_url:** <URL, or "not active">
- **linkedin_headline:** <current headline, for reference>

> Leave the handle/bio/headline blank (or "not active") for any platform not in `enabled_platforms`.

## Goals

- **goals:** <array: grow-audience / find-customers / find-job / pre-launch / learning-in-public / other>
- **specific_goal_notes:** <e.g. "Trying to get to 10k X followers by year-end to support book launch">

## Cadence

> Only fill cadence for platforms in `enabled_platforms`.

- **x_cadence:** <daily / 3x-week / 1x-week / as-i-go>
- **linkedin_cadence:** <daily / 3x-week / 1x-week / rarely>
- **best_posting_times:** <empty until we have 4+ weeks of analytics>

## Hard Nos

> Never draft content touching these topics.

- <e.g. family>
- <e.g. current employer by name>
- <e.g. politics>
- <e.g. specific clients under NDA>
- <add more>

## Decision Authority

- **publish:** Echo may publish approved original X/LinkedIn posts after explicit live approval on final text
- **engage (reply/comment/DM):** draft only, operator sends
- **follow/unfollow/like/repost:** never automated
- **change bio / headline / profile:** draft only, operator applies

## Personal Notes (for context, not for posting)

- **writing_times:** <when they're most likely to review drafts — morning? evening?>
- **content_blocks:** <topics that exhaust them to think about — avoid pushing these>
- **content_energizers:** <topics they lean forward on — lean into these>
- **current_projects:** <what they're working on now that might be worth documenting>

## Metadata

- **bootstrap_completed:** <YYYY-MM-DD, set when bootstrap finishes>
- **last_voice_retrain:** <YYYY-MM-DD>
- **total_posts_drafted:** 0
- **total_posts_published:** 0

---

_Keep this file tight. Stable truths only. Working notes go in `./memory/`._
