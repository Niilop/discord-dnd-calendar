# D&D Calendar Bot

A Discord-native scheduling bot for D&D servers. It supports multiple campaigns per server, player availability, sessions, RSVPs, session reminder cards, and a monthly calendar that stays up to date in its own channel.

- **Stack:** TypeScript (strict) · Node 24 · discord.js v14 · PostgreSQL 17 · Docker Compose · GitHub Actions → Hetzner VM
- **Design notes:** [docs/architecture.md](docs/architecture.md) · **Server setup:** [docs/server-setup.md](docs/server-setup.md)

## What it does

| Concept | What it means |
|---|---|
| **Server calendar** | One calendar per server, set up with `/calendar setup` (channel + timezone). It shows every campaign's sessions. The timezone is the group's, where "18:00" is planned: a region like *Central European Time* (summer time switches by itself) or a fixed `UTC+2`. Times are labelled with the offset, e.g. `18:00 (UTC+2)`, and cards also show each viewer's own time. Changing the timezone keeps sessions at the same clock time. |
| **Campaign** | Has a fixed **color**, DMs (campaign admins), players, a **current session** number (the last one played), and optionally a reminder channel. Membership lives in the database, keyed by Discord user ID. |
| **Availability** | Planning info, **per server**, and only ever **unavailability**: a player marks days they *can't* play or are *unsure* about. An unmarked day means nothing either way, so nobody is ever labeled "available". One mark applies to every campaign the player is in. |
| **Session** | Belongs to a campaign and takes its color. Has a start time (no length: it lasts until midnight), an optional title, notes and a status (`scheduled` / `cancelled` / `completed`). Upcoming sessions are numbered after the campaign's current session in date order ("Session 14: Into the Castle") and renumber when one is moved or cancelled; at midnight a session counts as played and becomes the current one. A session can be moved to another campaign, and its color changes with it. |
| **RSVP** | A reply to one specific session: *attending*, *maybe* or *can't attend*. Being available does **not** count as attending. |

The **calendar channel** holds one message: the current month drawn as a picture. Each day with a session is filled with its campaign's color. When two campaigns play the same day, the day is split into two colored halves. Unavailability is only a tiny marker in the corner (red = can't, amber = unsure), and a legend lists the campaigns. Below the picture is who can't play or is unsure on upcoming days, e.g. "**Thu 1 Oct** — @Alice can't · @Bob unsure". Then the controls:

Every button opens **your own private copy of the calendar**, so the shared one never moves for anyone else. You only ever have one: opening a new copy removes your previous one. After that, everything happens in that one message. `◀ / ▶` change the month and keep what you're doing, and the three mode buttons switch in place:

- **📅 My Availability**: pick days of the month you're looking at in the menu (they turn green on the calendar), then press **Can't play**, **Unsure** or **Clear**. Each day shows your current mark and that day's sessions.
- **➕ Add sessions** (DMs): pick the campaign (if you run several) and the days to play (green on the calendar), press **Create**, and confirm the start time. It's prefilled with what the campaign used last time. Days where players can't make it are marked ⚠️.
- **✏️ Edit sessions** (DMs): pick one of the month's sessions. Its details and controls appear under the calendar (its day turns green): move it to another campaign, change its date and time, or cancel it.

Days you can pick are today onwards. A menu holds at most 25 days, so a full future month shows two menus (1–15 and 16–end). **Done** closes the panel and leaves just the calendar.

Creating sessions posts nothing anywhere except the calendar. A campaign can optionally have a **reminder channel**, either its own or one shared with other campaigns. If it does, each session gets one **session card** there: posted 48h before (or right away for a session created later than that), with the details and RSVP buttons, and deleted when the session's day ends. So the channel only holds cards for the next couple of days.

A reschedule or cancellation doesn't post a notice. The session's card is reposted instead: it shows "📅 Moved from Thu 1 Oct 18:00" or "❌ CANCELLED" and moves to the bottom of the channel. If a session with a card moves further away, the card becomes a short "moved" note until the end of its old day. Changes to sessions further away than 48h post nothing, since the calendar shows them. Cards **don't ping anyone** unless the campaign turns on `reminder_pings`. The DMs' "Remind non-responders now" button always pings the members who haven't responded.

### Permissions

| | Server admin / calendar manager / bot admin | Campaign DM/admin | Player |
|---|:-:|:-:|:-:|
| Create / delete campaigns | ✅ | | |
| Add / remove DMs | ✅ | | |
| Edit campaign settings, add / remove players | ✅ | ✅ | |
| Create / edit / cancel / move sessions, see who responded | ✅ | ✅ (both campaigns, to move) | |
| See *who* is unavailable on a day | ✅ | ✅ | ✅ |
| Set **own** availability, RSVP | if member | ✅ | ✅ |
| Set up the server calendar, add / remove calendar managers | ✅ | | |

Full access (the first column) comes from any of:
- **Manage Server** (or Administrator) in Discord;
- being a **calendar manager** on that server: `/calendar manager-add user`, usable by anyone with full access, so it needs no Discord admin rights;
- being a **bot admin**: listed in `BOT_ADMIN_USER_IDS` in the host's `.env`, full access on every server the bot is in. Can't be removed from Discord.

Every mutation re-checks permission against the current database state and the member's live Discord permissions.

### Commands

| Command | Who | Purpose |
|---|---|---|
| `/calendar setup channel timezone` | server admin | Choose the calendar channel and the server timezone; posts the calendar |
| `/calendar show [month]` · `/calendar refresh` | everyone · DM | Private calendar view · re-post the calendar message |
| `/calendar manager-add user` · `manager-remove user` · `managers` | full access · everyone | Give or take full calendar rights on this server · list who has them |
| `/campaign create name color [dm] [reminder_channel] [current_session]` | server admin | Create a campaign, e.g. `color: red` or `color: #8e4ec6` |
| `/campaign edit campaign [name] [color] [reminder_channel] [no_reminders] [current_session] [reminder_hours] [reminder_pings]` | DM | Change settings, e.g. `current_session: 12` or `reminder_pings: true` |
| `/campaign add-player user` · `add-dm user` · `remove-member user` | DM / server admin | Membership |
| `/campaign info` · `/campaign list` | members | Settings and members |
| `/campaign delete campaign confirm_name` | server admin | Delete a campaign and all its sessions |
| `/availability edit [month]` | members | Your private calendar in *My Availability* mode |
| `/availability range status from [to]` | members | Mark a holiday in one go |
| `/session add [campaign] [month]` | DM | Your private calendar in *Add sessions* mode |
| `/session create date [campaign] [time] [title] [notes]` | DM | One session directly; time defaults to the campaign's last start time |
| `/session edit session [campaign] [title] [date] [time] [notes]` | DM | `campaign` moves the session; rescheduling updates its card |
| `/session cancel session [reason]` | DM | Marks its card cancelled, with the reason |
| `/session responses session` | DM | Who has / hasn't responded, plus a "Remind non-responders now" button |
| `/session list` | members | Upcoming sessions |

`campaign` is optional everywhere if you're only in one campaign. Otherwise pick it from the autocomplete.

## Discord application setup

1. Create an application at <https://discord.com/developers/applications>. Under **Bot**, reset and copy the token. From **General Information**, copy the Application ID.
2. You don't need any privileged intents. The bot only uses the `Guilds` intent.
3. Invite it with the `bot` and `applications.commands` scopes and these permissions: View Channels, Send Messages, Embed Links, Read Message History (permission integer `84992`):
   `https://discord.com/oauth2/authorize?client_id=<APP_ID>&scope=bot+applications.commands&permissions=84992`
4. Make sure the bot can post in the calendar and RSVP channels. `/campaign create` checks this.

## Local development

Requires Node 24 (`.nvmrc`) and a PostgreSQL database.

```bash
npm ci
cp .env.example .env            # fill in DISCORD_* and DATABASE_URL (see below)

# Postgres: use your own, or start the compose one on localhost:5433
docker compose -f docker-compose.yml -f compose.dev.yml up -d postgres
# DATABASE_URL=postgres://dnd:<POSTGRES_PASSWORD>@localhost:5433/dnd_calendar

npm run migrate:dev
DISCORD_DEV_GUILD_ID=<your test server> npm run register-commands:dev   # instant, guild-scoped
npm run dev                     # tsx watch
```

Checks (the same ones CI runs):

```bash
npm run lint && npm run typecheck && npm test && npm run build
```

Tests run against real PostgreSQL semantics through [PGlite](https://pglite.dev) (Postgres compiled to WASM, in-process). They apply the real migrations, so no Docker or database is needed to run them. They cover permissions, membership, availability, RSVPs, session scheduling (single, bulk, moving between campaigns), session cards, timezone/DST handling and the data migrations.

## Deployment

Hosting isn't decided yet, so every push and pull request only runs **check** (step 1 below). Steps 2 and 3 run only when the workflow is started by hand (Actions → CI/CD → Run workflow on `main`). The workflow in `.github/workflows/ci-cd.yml` runs:

1. **check:** lint, typecheck, tests, build
2. **image:** builds the Docker image and pushes it to GHCR as `sha-<commit>`. Deploys use the immutable digest.
3. **deploy** (GitHub environment `production`): SSHes to the VM with a pinned host key, uploads `docker-compose.yml` and `scripts/`, and runs `scripts/deploy.sh <image@digest>`, which:
   - pulls the image and makes sure Postgres is up
   - takes a **pre-deploy backup**
   - runs **migrations** (`dist/scripts/migrate.js`)
   - registers slash commands (idempotent bulk overwrite)
   - replaces the bot container and **waits for its healthcheck**
   - if the new container isn't healthy, rolls back to the previous image and fails the job

Nothing in the deploy path removes volumes or data. The bot also refuses to start if the database has pending migrations.

**GitHub secrets** (repository or `production` environment):

| Secret | Value |
|---|---|
| `DEPLOY_HOST` | VM IP or hostname |
| `DEPLOY_USER` | `deploy` |
| `DEPLOY_SSH_KEY` | Private key of a deploy-only SSH key pair |
| `DEPLOY_SSH_KNOWN_HOSTS` | Output of `ssh-keyscan -t ed25519 <host>`, verified against the VM's fingerprint |

Optional variable: `DEPLOY_APP_DIR` (default `/opt/dnd-calendar`). Runtime secrets (Discord token, DB password) live only in `/opt/dnd-calendar/.env` on the server. See [docs/server-setup.md](docs/server-setup.md) for the one-time VM setup.

Useful commands on the server:

```bash
cd /opt/dnd-calendar
scripts/compose.sh ps
scripts/compose.sh logs -f --since 1h bot
scripts/compose.sh exec bot node -e "fetch('http://127.0.0.1:8080/healthz').then(r=>r.text()).then(console.log)"
```

## Backups and restore

- `scripts/backup.sh` runs `pg_dump` (custom format) inside the Postgres container and writes the file **to the host** (`BACKUP_DIR`, default `/var/backups/dnd-calendar`). It then checks the file with `pg_restore --list` and prunes local copies older than `BACKUP_RETENTION_DAYS` (default 14).
- **Off-server copy:** if `BACKUP_RCLONE_REMOTE` is set in `.env`, each dump is also uploaded with [rclone](https://rclone.org). Any rclone backend works: a Hetzner Storage Box over SFTP, S3, Backblaze B2, and so on. Wrap it in a `crypt` remote to encrypt at rest. `BACKUP_RCLONE_RETENTION_DAYS` prunes the remote. Configure this: a VM-only backup doesn't survive losing the VM.
- **Schedule:** a systemd timer (`deploy/systemd/`) runs it daily at ~03:30 UTC. Deploys and restores also take their own backups first.

**Restore:**

```bash
cd /opt/dnd-calendar
ls -lt /var/backups/dnd-calendar/            # or: rclone copy <remote>/<file> /tmp/
scripts/restore.sh /var/backups/dnd-calendar/dnd_calendar-20261017T033000Z-daily.dump
```

`restore.sh` asks for confirmation and takes a `pre-restore` safety backup. It stops the bot and restores with `pg_restore --clean --single-transaction`, so a failed restore changes nothing. It then applies any newer migrations and starts the bot again. To restore onto a **new VM**, follow the server setup, deploy once, then run `restore.sh` with a dump copied from the off-server remote.

Test a restore now and then. A backup you've never restored is only a hope.

## Project layout

```
src/
  domain/        pure rules: types, permissions, time/timezones, availability, RSVP, reminders
  db/            pg pool + transactions, migration runner, SQL repositories
  services/      use cases: transactions + permission checks (no Discord imports)
  discord/
    commands/    slash command definitions and handlers (one file per command)
    components/  button / select / modal handlers
    render/      embeds and components (calendar, RSVP card, editors, pickers)
    publisher.ts keeps calendar messages and session cards in sync
    router.ts    interaction dispatch + error handling
  scheduler/     session cards, auto-completion, calendar rollover
  scripts/       migrate, register-commands
migrations/      plain SQL, applied in order
scripts/         server-side deploy / backup / restore
deploy/systemd/  backup timer
test/            vitest (domain, services on PGlite, rendering)
```
