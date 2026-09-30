# Architecture notes

This bot serves a handful of campaigns on small private servers. It runs as **one process** next to **one PostgreSQL** on one VM. Everything below follows from that: no queues, no caches beyond memory, no service boundaries.

## Layers

```
Discord gateway
   │ interactionCreate
   ▼
discord/router.ts ──► commands/*  ─┐
                  └─► components/* ├─► services/*  ──► db/repositories/* ──► PostgreSQL
                                   │      │
                                   │      └─► domain/* (pure: permissions, time, availability, RSVP, reminders)
                                   └─► publisher.ts ──► render/* ──► Discord REST
scheduler/* ─────────────────────────► services / repositories + publisher
```

- **domain/** has no I/O. Permission rules, timezone math, availability aggregation, RSVP grouping and the session-card rules are unit-tested directly.
- **services/** are the use cases. Each mutation runs in one transaction that (1) loads the campaign scoped to the caller's guild, (2) checks the permission against the *current* membership row, and (3) writes. Services never import discord.js.
- **discord/** turns interactions into service calls and renders results. After a committed mutation, handlers call the **publisher** to update Discord messages.
- **scheduler/** is an in-process interval (60s). Its tasks are idempotent and read their state from the database.

## Data model

See `migrations/`. Notes on choices that go beyond the brief:

- **One calendar per server** (`guild_settings`: timezone, calendar channel, calendar message). Campaigns are distinguished by a fixed `color`, and their `timezone` is read from the server settings through a join (`db/repositories/campaigns.ts`), so there is one timezone and one calendar. Migration `0003` converted the earlier per-campaign calendars.
- **Availability is per server** (`availability (guild_id, discord_user_id, date)`). With one calendar, one availability menu, and sessions that can switch campaign, being unavailable "for one campaign but not another" stopped making sense. Counts only include current campaign members: the whole server on the calendar, one campaign's members when scheduling for it. When migrating, conflicting per-campaign marks merged with *unavailable* winning.

- **Absence of a row means "unspecified" / "no response".** `availability.status` only allows `unavailable | prefer_not`, and `session_rsvp.status` only allows `attending | maybe | absent`.
- **Enumerations are `text` + `CHECK`**, not Postgres enums. Adding a `scheduler` role is a one-line migration plus one entry in `ROLE_PERMISSIONS`.
- **Moving a session to another campaign** (`session.campaign_id` update) needs scheduling rights in both campaigns. RSVPs from people not in the new campaign are dropped, and its card follows it to the new campaign's reminder channel.
- **RSVPs are not FK'd to membership.** When a member is removed, the service deletes their RSVPs to sessions that haven't ended yet. Past attendance is kept as history.
- **Session cards** (`session.discord_channel_id`, `discord_message_id`, `card_starts_at`): a session has at most one message in its campaign's reminder channel, and the posted card is its own idempotency record. `card_starts_at` is the start time the card was made for. When the session moves away, the card becomes a "moved" note that expires at the end of that day. `previous_starts_at` gives the "Moved from …" line, and `cancel_reason` is shown on a cancelled card.
- **`campaign.reminder_minutes`** (default 2880 = 48h, NULL = no automatic card) and **`campaign.reminder_pings`** (default off) are per campaign (`/campaign edit reminder_hours: 48 reminder_pings: true`). Migration `0005` replaced `reminder_offsets_minutes int[]`, keeping the longest time. The old column stays one release for rollback.
- **`session_notification (session_id, kind)`** is an idempotency log for future automations with their own `kind`, such as "everyone has responded". Session cards don't use it.
- **Session numbers:** `campaign.current_session` is the last played session's number. The `session_numbered` view numbers scheduled sessions `current_session + 1, + 2, …` in date order, so moving, cancelling or changing the setting renumbers them with no stored state to fix up. Completing or cancelling a session freezes its number in `session.number`; completing also raises `current_session`. `session.title` is an optional subtitle. Every session read goes through the view; writes re-read the row.
- **No session length:** `ends_at` is the end of the session's local day. RSVPs close and the session counts as played then. `default_session_duration_minutes` is no longer read (dropped after one release).
- **Timezones:** `guild_settings.timezone` is an IANA zone (the region names in `domain/time.ts`, e.g. *Central European Time* = `Europe/Paris`) or a whole-hour fixed offset (`UTC+2`). Only the offset is shown next to times. Changing it keeps every scheduled session's clock time and redraws all cards.
- Discord snowflakes are `text`. IDs are `integer` identities. That's plenty at this scale, and `pg` returns them as JS numbers.

## Time

- Session start/end are `timestamptz` (UTC). Availability dates are `DATE`s in the server's timezone. Luxon does all conversions in `domain/time.ts`.
- A wall-clock time that doesn't exist because of a DST jump (e.g. 03:30 on spring-forward night) is **rejected** with a clear message, not silently shifted. An ambiguous time (fall-back night) resolves to the earlier instant.
- Messages show times in the server timezone and also as a Discord `<t:…>` timestamp, which each viewer sees in their own timezone.
- A session belongs to the local date (and month) on which it starts.

## Discord interaction design

- **Calendar:** one persistent message per server, always showing the **current** month, edited in place. Its buttons open a private copy (see below), so one user's browsing never moves the shared view. Per-player absences never appear as entries, only as a tiny count marker. *Day details* lists names for campaign members.
- **Private calendar (all interaction):** every button on the shared message (`◀ / ▶` and the three modes) opens the user's own ephemeral copy of the calendar. From then on everything edits that one message in place. The copy is the same picture and buttons plus a panel for its mode: *view* (none), *My Availability*, *Add sessions*, *Edit sessions*. Month buttons keep the mode, and **Done** returns to view. The whole state (mode, month, campaign, picked-day bitmask) lives in the custom IDs (`cv:<mode>:<month>:<campaign>:<mask>:<session>`), so there's no server-side session state. This replaced separate panels per action, which piled up extra messages and were stuck on one month.
- **One private calendar per person:** opening a new copy (a shared-calendar button or `/calendar show`, `/availability edit`, `/session add`) deletes the person's previous one, through the interaction that last showed or updated it (`discord/privateCalendar.ts`, in memory). Discord only allows that within 15 minutes of that interaction, so an older copy is left alone. With rapid clicks, each replacement waits until the previous message exists before deleting it.
- **Day menus:** a multi-select of the month's upcoming days. Discord caps a menu at 25 options, so more than 25 pickable days (only a full future month) splits into two menus, 1–15 and 16–end. Each menu's ID carries its day range, so picking in one keeps the other's picks (`render/dayMenu.ts`). Picking only *selects*: picked days are drawn with a green outline and check on the calendar image, and nothing is saved until a button is pressed.
- **My Availability:** each day shows the viewer's own mark and that day's sessions. **Can't play / Unsure / Clear** apply to exactly the picked days.
- **Add sessions:** a campaign menu (colored emoji) if the DM runs several, the day menu, and **Create N sessions**, which opens a modal for the start time (prefilled from the campaign's last session). Creation is one transaction. The redrawn calendar then shows the new sessions. Day options show sessions already on that day and how many of this campaign's players can't make it or are unsure (⚠️). This is information only; the bot never recommends a date.
- **Edit sessions:** a menu of the month's upcoming sessions the viewer can edit. Picking one keeps the calendar and shows the session under it (its day highlighted): move to another campaign, change date/time (modal), or cancel with a confirmation step. The picked session is part of the calendar state (`cv:…:<session>`), and month/mode buttons drop it. A session that moves to another month takes the view with it; a cancelled one leaves the list.
- **Session channel (the campaign's reminder channel):** each session gets at most one card there, and only from the reminder window (48h before) until its local day ends (`domain/reminders.ts`). A session created inside the window gets its card right away. A reschedule or cancellation reposts the card (the new one goes up, the old one is deleted) instead of posting a notice, so the change shows at the bottom of the channel without adding a message. A session moved out of the window leaves a short "moved" note until the end of its old day. Nothing pings anyone unless the campaign turns on `reminder_pings`. The DMs' "Remind non-responders now" is the exception: it always pings. Several campaigns can share one channel or have their own.
- **RSVP:** buttons on the session card. The click is recorded for the clicking user and the card is re-rendered from the database; the updated card is the confirmation, so there is no private reply (errors still get one).
- **Calendar as an image:** campaigns are color coded, and Discord can't show custom colors in text or buttons (buttons have four fixed colors, and ANSI-colored code blocks don't render on mobile). So the month is drawn as SVG (`render/calendarImage.ts`, pure string building) and rasterized with `@resvg/resvg-js` using the bundled Inter font (`assets/fonts`, OFL). A render takes about 40ms. Each session day is filled with its campaign's color. Two sessions split the day into two halves showing just their times (the color identifies the campaign), and three or more show "+N more". The legend lists the campaigns. The picture itself isn't clickable, because Discord has no clickable image regions, so interaction goes through the menus and buttons below it.
- **Layout versioning:** `guild_settings.calendar_message_layout` records which layout the persistent message uses. Discord can't edit a classic embed message into a components-v2 one, so a version bump makes the publisher post a fresh message and delete the old one.

### Stale state and safety

- Custom IDs (`v4:<kind>:<ids…>`) carry only identifiers and view state, never authority. Every handler reloads from the database and re-checks permission, so an old button still behaves correctly: it's rejected if the user lost access, or the session was cancelled or has ended. Unknown or old-format IDs get a "use a fresh one" message.
- A campaign or session ID that belongs to another guild is treated as "not found".
- Server-admin status comes from `interaction.memberPermissions`, which Discord sends fresh with each interaction.
- The publisher always **re-renders from the database** instead of patching, and serializes work per message. A burst of concurrent RSVP clicks converges to the correct final state. Calendar refreshes are debounced (2s) so rapid availability edits cause one edit.

### Discord failures

- discord.js's REST client handles rate limits and retries transient failures (`retries: 3`).
- If the calendar message was deleted, it is re-posted and the new ID stored. If a channel's permissions are broken, the error is logged and the scheduler retries later with back-off. A failed session card post or delete is simply redone on the next tick, since the card task re-derives everything from the database.
- User-facing errors (`UserError`) are shown ephemerally. Unexpected errors are logged with the interaction ID, and the user sees that ID as a reference.

## Scheduler tasks

| Task | What |
|---|---|
| `complete-sessions` | `scheduled` → `completed` once `ends_at` passes. Updates the card and removes its buttons. |
| `session-cards` | Posts cards as reminder windows open, moves them when the reminder channel changes, and deletes them when their day is over. |
| `calendars` | Re-renders each calendar when the campaign's local date changes (rollover, "today" marker) and retries failed refreshes. |

To add a behaviour (e.g. "notify the DM when everyone has responded"), write a new `SchedulerTask` that claims its own `session_notification` `kind`. For instant reactions, call it from the RSVP handler.

## Deployment decisions

- **GHCR + digest-pinned deploys** instead of building on the VM: CI builds once, and the VM only pulls. The previous image digest makes rollback instant.
- **Plain SSH from Actions** with a pinned `known_hosts` instead of a third-party deploy action: fewer supply-chain dependencies. The GHCR login on the VM uses the job-scoped `GITHUB_TOKEN` and is logged out afterwards.
- **Migrations are forward-only and run before the new container starts.** Rollback restores the previous *image*, not the schema. So migrations must stay backwards compatible for one release (expand, then contract), and a pre-deploy backup is always taken.
- **Health:** a tiny HTTP endpoint (`/healthz`, container-internal) reports Discord gateway readiness and a DB ping. Docker's healthcheck uses it, and `docker compose up --wait` gates the deploy on it.
- **Graceful shutdown:** SIGTERM stops the scheduler, waits for in-flight publisher work, closes the gateway, then the DB pool. `stop_grace_period: 30s`.
- **Backups** run on the host (systemd timer) rather than in a sidecar container. This keeps the dump files and the off-site upload tooling (rclone) outside Docker, where they survive a broken stack.

## Deliberately not done (yet)

- **Importing members from a Discord role.** This would need the privileged Guild Members intent. Database membership is authoritative, and `/campaign add-player` is quick for small groups.
- **Recurring sessions, per-user timezone preferences, localization.** Easy to add on this model if wanted.
- **Multi-instance operation.** The scheduler assumes a single bot process. Calendar debouncing and the per-session card queue are in-memory.
