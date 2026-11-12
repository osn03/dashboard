# Personal dashboard

One place for today's schedule, tasks, deadlines and training. Runs locally on your computer.

## Status

| Area | State |
|---|---|
| Tasks, Today, calendar (day / week / month / agenda), settings, reminders, export | **Working.** Automated and browser tests. |
| Google Calendar: several accounts, several calendars, colours, default destination, read-only handling, sync, create / edit / delete, recurring occurrence vs series | **Working for reading** — verified live against a real account (4 calendars, 1,826 events, full + incremental sync). **Writing** (create / edit / delete / time-block copies) is tested against a simulated Google only. |
| Intervals.icu import (planned, completed, wellness), Training page and card | Built; tested against a simulated API only. Needs your API key for a live check. |
| Assistant on your Claude Code subscription sign-in (default) | Built. Authentication, tool lockdown and a tool round trip were **checked live** with two small requests; everything else is tested with a scripted stand-in. |
| Assistant on Claude API or ChatGPT (pay-per-use, opt-in) | Built; tested with scripted models only. |
| Weekly review, notes on tasks and projects, demo mode | **Working.** Browser tests. |

## Quick start

Requires Node.js 22+ (developed on 24) and npm.

```
npm install
npm run setup     # creates .env with a fresh encryption key (prints no secrets)
npm run build
npm start         # http://127.0.0.1:8787
```

On first visit you choose a username and password (min. 10 characters).

| Command | What it does |
|---|---|
| `npm start` | Runs the app on http://127.0.0.1:8787 (serves the built UI) |
| `npm run build` | Rebuilds the UI after code changes |
| `npm run dev` | Development mode with live reload: UI on :5173, API on :8787 |
| `npm run demo` | **Demo mode** with sample data on http://127.0.0.1:8788 (see below) |
| `npm test` | Unit, API and mocked-integration tests |
| `npm run e2e` | Browser tests (first run needs `npx playwright install chromium`) |
| `npm run backup` | Writes a consistent copy of the database to `data/backups/` |

### Run without a terminal window

Double-click **`Dashboard.vbs`** in the project folder (or make a shortcut to it on the desktop or Start menu). It starts the server with no window at all, opens the dashboard in your default browser, and the server stops by itself about 20 seconds after the last dashboard tab is closed. If the dashboard is already running, it just opens the browser.

- No terminal window appears, also not later when the assistant starts Claude Code: the server runs with a hidden console that everything it starts inherits.
- Output that the terminal would have shown goes to `data/server.log`.
- While it is stopped nothing runs: no background sync and no reminders. Everything catches up when you open it again.
- `npm start` (in a terminal) keeps running until you stop it; only the launcher uses auto-stop. `npm run launch` does the same as the launcher but inside the terminal you run it from.
- To start it automatically at login, put a shortcut to `Dashboard.vbs` in the folder that opens with `Win+R` → `shell:startup`.

**After updating the code:** stop the app (Ctrl+C), run `npm run build`, then `npm start`. Database changes are applied automatically on start, and a copy of the database is saved to `data/backups/before-upgrade-<time>.db` first.

Keyboard: `N` new task, `/` search tasks, `1`–`5` Today / Tasks / Calendar / Training / Review, `Esc` closes dialogs.

## How it behaves

- **Planned day vs deadline.** A task has an optional planned day and a separate optional deadline. Moving the planned day never changes the deadline.
- **Dates are dates.** Planned days and date-only deadlines are stored as `YYYY-MM-DD` and never pass through a timezone. Timed things are stored as UTC instants and shown in the timezone from Settings (default Europe/Oslo), not the browser's.
- **Calendar day structure.** Each day has separate areas: *All-day* events, *Tasks* (planned that day, no time), *Training* (workouts without a start time; shown only when there are any), and the *timed schedule*. Deadlines are red "Due" flags.
- **Tasks and time blocks.** Dragging a task into the schedule creates a linked time block; the task is not copied and its deadline is untouched. Every drag has a click/tap alternative in the task and block dialogs.
- **Recurring tasks** keep the finished one and create the next occurrence. **Missed tasks** stay visible until completed, rescheduled or dismissed.
- **Time available** = remaining working hours minus timed commitments, compared with estimates of today's untimed tasks. Tasks without an estimate are counted separately.
- **Reminders** are delivered while the dashboard is open in a browser tab.
- **Weekly review** (Review page): completed, unfinished, deadlines ahead, Inbox to sort, and planned vs completed training, for any week.
- **Notes.** Besides a description, tasks and projects can have dated notes (task dialog → "Dated notes"; project view → "Project notes").

## Google Calendar

### Connect (once)

You need your own Google OAuth client. **Do not paste the secret into any chat** — it goes only into `.env`.

1. <https://console.cloud.google.com/> → create a project.
2. *APIs & Services → Library* → **Google Calendar API** → **Enable**.
3. *OAuth consent screen*: **External**; add yourself (and any other Google account you want to connect) under **Test users**.
4. Scopes: `.../auth/calendar.calendarlist.readonly` and `.../auth/calendar.events` (the only permissions requested).
5. *Clients → Create client* → **Web application**; Authorized redirect URI: `http://127.0.0.1:8787/api/google/callback`
6. Put the values in `.env` as `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`, restart, open **http://127.0.0.1:8787** (this exact host), *Settings → Google Calendar → Connect*.

While the consent screen is in **Testing**, Google expires the connection after 7 days ("Access lost – Reconnect"). Set the publishing status to **In production** to avoid that; the "unverified app" warning is expected for a personal client.

### Calendars and accounts

- **Settings → Google Calendar** lists every calendar of every connected account. Tick the ones to show, pick a colour for each (defaults to Google's colour), choose where **new events go**, and optionally where **copies of task time blocks** go.
- Selected calendars are combined in all calendar views and on Today. Each event shows its calendar (and account when there are several) and uses that calendar's colour.
- When creating an event you can choose another destination in "Save to".
- **Read-only** calendars and events are marked, cannot be chosen as a destination, and are refused by the server if edited.
- **Add another Google account** signs in a second account next to the first. Each account has its own encrypted token; signing in again with a known account reconnects it. One account losing access does not affect the other.
- Each calendar has its own sync token and its own event store, keyed by (calendar, event id), so the same id in two calendars never collides. A calendar shared into two connected accounts shows up once per account — tick only one of them.
- Sync: last 90 days onward on first sync, then incremental every `GOOGLE_SYNC_MINUTES` (default 5) and on "Sync now". Expired sync tokens trigger a clean resync. Repeating events are expanded by Google.
- Writes use `sendUpdates=none` and never add guests: no invitations or notifications. A changed-elsewhere event is detected (ETag) and reloaded rather than overwritten. Creation uses a client-chosen id so retries cannot create duplicates.
- **Hide here**: any Google event can be hidden in the dashboard without changing Google (undo under Settings → Hidden Google events). The event dialog suggests this when an Intervals.icu workout with the same title exists on the same day. Nothing is merged automatically.

### Copies of time blocks (optional, off by default)

With "Copy task time blocks to" set, every time block gets exactly one event in that calendar. Its id is derived from the block, so repeats and retries update the same event. Moving, renaming, completing or removing the block (or deleting its task) updates or removes the copy; switching the option off removes all copies. The dashboard shows the block once, never the block plus its copy. If Google is unreachable the block is still saved, marked "Google copy not updated", and retried at the next sync. Edits made to a copy inside Google are overwritten by the dashboard.

## Connect Intervals.icu (read-only)

1. In Intervals.icu: **Settings → Developer Settings**. Note your **Athlete ID** (like `i12345`) and the **API key**.
2. Put them in `.env` as `INTERVALS_ATHLETE_ID` and `INTERVALS_API_KEY`. Restart.
3. *Settings → Intervals.icu → Import now* (also runs every `INTERVALS_SYNC_MINUTES`, default 30).

What is imported (window: 90 days back, 60 days ahead): planned workouts and races, completed activities, daily wellness. Rows are keyed by Intervals.icu's ids, so repeated imports update in place. Rules:

- A value Intervals.icu does not provide is shown as "—" / "not recorded", never as 0. Sums state how many items had no value.
- Planned and completed totals are shown side by side and never added. A planned workout is "done" when Intervals.icu has paired an activity with it; in the calendar the pair is shown once (as the completed activity).
- Workouts without a start time go in the Training row; ones with a time go on the schedule. All training is read-only.
- Activities synced from Strava are exposed by Intervals.icu without details; they are listed as "Details unavailable".
- Workout times are interpreted in the dashboard's timezone.
- Nothing is ever written to Intervals.icu (the import only sends GET requests).

## Set up the assistant (optional)

By default the assistant runs on **your locally installed Claude Code, signed in with your own Claude subscription**. No API key is needed and nothing is billed per request to an API account. Two pay-per-use alternatives (Claude API, ChatGPT) remain available if you select them explicitly.

### Claude Code with your subscription (default)

Setup on Windows:

1. Install Claude Code if you have not already (Anthropic's instructions: <https://code.claude.com/docs/en/setup>). Check with `claude --version` in a terminal.
2. Sign in once: run `claude auth login` in a terminal and complete the sign-in in the browser with your Claude account. This is Anthropic's own sign-in; the dashboard never sees your password or any token.
3. Restart the dashboard, open *Settings → Assistant*. It should show **Connected**, "Claude subscription (… plan)". Press "Check again" after any change.
4. If Claude Code is installed in an unusual place, set `CLAUDE_CODE_PATH` in `.env` to the full path of `claude.exe`.

What to expect:

- **Shared limits.** Assistant requests count against the same usage limits as Claude Code and the Claude apps on your subscription. Heavy use elsewhere leaves less for the assistant, and the reverse.
- **Models.** Choose the model in Settings. The default is **Sonnet** (included in plans). Haiku is lighter; Opus is included but uses limits much faster. **Fable can be billed to usage credits instead of your plan's included limits**, depending on your plan — it is labelled and never the default.
- **Paid extra usage is off by default.** If your plan's limit is used up and your account has extra usage enabled, Claude would charge further requests to usage credits. The dashboard stops as soon as Claude reports this and stays paused until the limit resets. The first request that reveals it has already been charged at that point — the dashboard cannot know beforehand. You can allow extra usage in Settings.
- **No silent API billing.** The dashboard never passes an API key to Claude Code (the process gets a small allow-listed environment). If Claude Code itself is signed in with a Console/API account, or reports at start-up that it would use an API key, the assistant refuses to run and tells you why. If Claude Code is unavailable, the assistant stops with a message; it never switches to the Claude API or ChatGPT by itself.
- **Local only.** The subscription assistant answers only when the dashboard is opened on this computer (`http://127.0.0.1`). Requests that arrive through a reverse proxy or tunnel (for example Cloudflare Tunnel), or to another host name, are refused, and the dashboard must be listening on a loopback address. Claude Code itself is never reachable from the network: the browser can only send a chat message to the dashboard, which starts Claude Code as a local child process.

How it is built:

- The backend uses the official **Claude Agent SDK** to run the unmodified `claude.exe` you installed (`pathToClaudeCodeExecutable`). The executable is started directly with an argument array, never through a shell; your message is sent on stdin.
- Sign-in status comes from `claude auth status`. The dashboard does not read, copy, store or display credentials.
- Claude Code's own tools are switched off (`tools: []`), other MCP servers and all user/project settings are ignored, and only the dashboard's tools are registered. Before the first model request of every run the dashboard checks the tool list Claude Code reports and stops if anything else is present. A second check runs before each tool call.
- Sessions are not saved in Claude Code. The conversation text is stored in the dashboard database (*Clear conversation* deletes it); it contains no credentials.
- Stop button, a time limit per request (`CLAUDE_CODE_TIMEOUT_SECONDS`, default 240), expired sign-in, plan limits and a missing installation each produce a specific message.

**Is this allowed?** Anthropic's documentation says subscription limits "assume ordinary, individual usage of Claude Code and the Agent SDK", and that nothing prevents "an end user from signing in to the unmodified Claude Code binary with their own Claude subscription". What is not permitted is offering Claude.ai sign-in to *other people* through your own product, routing other users' requests through your subscription, or collecting or handling the sign-in tokens yourself (<https://code.claude.com/docs/en/legal-and-compliance>). This integration is built to stay inside that: one person, their own machine, their own sign-in, the official sign-in flow, no token handling. If you ever let other people use this dashboard, or host it for others, switch the assistant to an API key. This is my reading of the published documentation, not legal advice; Anthropic can change these terms.

**Remote access assessment.** If you expose the dashboard remotely, everything except the assistant keeps working behind its own login. The subscription assistant stays off for remote requests because (a) a second person reaching it would be using your subscription, which the terms above do not allow, (b) the dashboard's single password would then be the only thing between the internet and an agent that can propose calendar changes, and (c) a tunnel makes "this computer" unverifiable. There is no switch to override this. For remote assistant use, select an API-key provider instead.

### Pay-per-use alternatives (only if you select them)

| | Claude API | ChatGPT |
|---|---|---|
| Get a key | <https://console.anthropic.com/> → API keys | <https://platform.openai.com/api-keys> |
| `.env` key | `ANTHROPIC_API_KEY` | `OPENAI_API_KEY` |
| `.env` model (optional) | `ANTHROPIC_MODEL`, default `claude-opus-5-5` | `OPENAI_MODEL`, default `gpt-6.1-sol` |

Both are billed per request on the provider's developer account. A Claude or ChatGPT subscription does not cover API use. Having a key in `.env` does not make the assistant use it: you choose the provider under *Settings → Assistant → Assistant runs on*.

### What the assistant can and cannot do (all providers)

- It can only call a fixed set of dashboard tools with validated inputs: look up the schedule, tasks, free slots, calendars and (if you allow it) training; and *propose* changes. There is no shell, file, code, web or database tool. This is enforced by the backend, not by the prompt.
- **Lookups** run directly. **Every change** — tasks, time blocks, events, bulk rescheduling, deletions, anything in Google — is stored as a *proposal* with a preview and runs only when you press **Confirm**.
- A confirmation carries a fingerprint of exactly what was previewed. The server refuses it if the fingerprint does not match the stored operation, and a proposal can run at most once (a second click or a retry is rejected).
- The result shown after confirming comes from the real operation. The **Action history** tab lists everything; **Undo** is offered where possible.
- Text from calendars and notes is passed to the model as data, labelled as untrusted, with an instruction not to follow it. Even if a model did, it could only create proposals for you to reject.
- **Screenshots and photos.** In the assistant panel you can paste a screenshot (Ctrl+V), drop an image, use *Attach image*, or use *Capture screen* (the browser asks which window, tab or screen; one still picture is taken and sharing stops). Up to 4 images per message; large ones are scaled down in the browser first. The assistant can read them — for example a timetable or an invitation — and propose tasks or events, which you still confirm. Text inside an image is treated as information, not as instructions. Images are sent to the selected provider, stored with the conversation in the dashboard database, stay available for a few follow-up questions, and are deleted by *Clear conversation*. Files are checked to really be PNG, JPEG, WebP or GIF before they are stored or sent.
- What is sent to the selected provider: your message, the stored conversation, and what the model looks up (task titles, dates, short task descriptions, event titles, times, locations). Event descriptions are not sent. Training and wellness data only if you switch it on in Settings.

## Demo mode

`npm run demo` starts a second, separate instance on **http://127.0.0.1:8788** with sample tasks, a pretend Google account and pretend training data. Sign in with `demo` / `demo-password`.

- It uses its own database file, `data/demo.db`. It never opens your real database.
- No integration makes a network call in demo mode; the assistant is off. A banner shows on every page, and demo accounts are labelled as such.
- It can run at the same time as the real app. Delete `data/demo.db` to reset it.

## Architecture

```
shared/   Pure logic for both sides: date rules, recurrence, calendar layout, zod schemas
server/   Hono HTTP API on Node
  app.ts            routes, auth + CSRF middleware, input validation on every mutation
  repo.ts           SQL for tasks, time blocks, local events, projects, notes
  db.ts             SQLite + numbered migrations (server/migrations/), auto-backup before upgrades
  auth.ts           scrypt password hash, hashed session tokens, login rate limit
  crypto.ts         AES-256-GCM for integration tokens at rest
  google/client.ts  HTTP adapter for Google OAuth + Calendar API (retries, backoff)
  google/service.ts accounts, per-calendar sync, idempotent writes, conflicts, time-block copies
  intervals.ts      Intervals.icu client + read-only import + training summaries
  assistant.ts      tool definitions, proposal log, confirmed execution, undo
  claudeCode.ts     runs the local Claude Code (subscription sign-in) through the Agent SDK, locked to dashboard tools
  openaiLlm.ts      adapter that lets OpenAI models drive the same assistant
  demo.ts           sample data for demo mode
web/      React + Vite + TanStack Query frontend (no secrets, talks only to /api)
tests/    Vitest; fakeGoogle.ts and the fakes inside the test files stand in for outside services
e2e/      Playwright against the real server (throwaway database) and against demo mode
```

Source of truth: this app for tasks, time blocks and local events; Google for Google events (local copy is a cache); Intervals.icu for training (local copy is a cache).

Security: single user; every `/api` route except sign-in needs a session (HttpOnly, SameSite=Lax cookie; only a hash of the token is stored); state-changing requests need a custom header and same-origin `Origin`. Secrets live only in `.env` (git-ignored). Google refresh tokens are encrypted with `APP_ENCRYPTION_KEY`; API keys stay in server memory. Nothing secret reaches the browser, exports or logs. The server listens on 127.0.0.1 by default. Create your account before exposing the app beyond your machine.

## Tests

Run on 2026-11-11 (Windows 11, Node 24):

- `npm test` — **119 passed.**
  - Dates, DST, recurrence, layout, available time; API against real SQLite.
  - **Mocked Google** (`tests/fakeGoogle.ts`): OAuth, paging, incremental sync, expired tokens, retries, duplicate prevention, ETag conflicts, read-only, recurring events, several calendars and accounts, hiding, time-block copies, revoked access, and the upgrade of an existing database.
  - **Mocked Intervals.icu**: auth header, GET-only, no duplicates on repeat import, missing ≠ zero, planned vs completed, timed vs untimed, outages.
  - **Scripted Claude Code / Agent SDK** (`tests/claudeCode.test.ts`, no subscription usage): missing installation, signed out and expired sign-in, API-key sign-in refused, API key source at start-up refused, secrets withheld from the child process, paths with spaces, shell metacharacters, tool lockdown and unauthorized tool calls, read → propose → confirm → execute, wrong or missing fingerprint, duplicate confirmation, altered proposal, plan limit, paid extra usage, credits required, cancellation, timeout, remote requests refused.
  - **Images in the assistant** (`tests/images.test.ts`, mocked providers): the format each provider receives, storage and deletion, follow-up questions, and rejection of non-images, mismatched types, oversized files and too many attachments.
  - **Scripted OpenAI Responses API**: request shape, tool round trip including reasoning items, proposals until confirmed, malformed arguments, refusals, provider choice.
  - **Scripted model** for the assistant: lookups without confirmation, proposals not executed until confirmed, bulk reschedule keeps deadlines, external writes only after confirmation and never duplicated, failures recorded as failed, read-only refused, training data withheld unless enabled.
- `npm run e2e` — **13 passed**: main journey (desktop), sending an assistant message and attaching screenshots, the assistant panel layout at desktop and phone width (no overlapping or squashed messages and cards, independent scrolling, follow-only-when-at-the-bottom, during a reply in progress and after confirming), a tap-only phone run, and demo mode.
- **Live checks actually performed:** reading from a real Google account — calendar list, full sync and incremental sync of four calendars (two read-only), run on a copy of the real database; only GET requests to the Calendar API. This is also how a bug was found and fixed (sync never ran if the app had started before an account was connected).
- **Live check of the subscription assistant (2026-11-11):** `claude auth status` reported a claude.ai sign-in on a Pro plan; two small Haiku requests ran through the dashboard's runner with the real Agent SDK and `claude.exe` 2.1.322. Verified: Claude Code reported no API key in use (`apiKeySource: none`), the only tool it exposed was the dashboard's, a dashboard tool was called and its result used, text streamed, and a request to run a shell command and read a file was answered with "no such tool". Not verified: how these requests appear on the account's usage page, and the full dashboard tool set against the real model (stopped early because the account was already past its 5-hour limit and the two requests were charged to extra usage).
- **Not tested live:** writing to Google (create / edit / delete, time-block copies), a second Google account, Intervals.icu, the Anthropic API and the OpenAI API.

## Backup and restore

- `npm run backup` (safe while running) → `data/backups/dashboard-<time>.db`. Upgrades also save `before-upgrade-<time>.db` automatically. Keep a copy of `.env` too: without the same `APP_ENCRYPTION_KEY` the stored Google tokens cannot be read (you would reconnect).
- Restore: stop the app, replace `data/dashboard.db` with a backup (delete `dashboard.db-wal` / `-shm` if present), start the app.
- *Settings → Export as JSON*: readable copy of tasks, events, projects and notes (no passwords or tokens). No JSON import.

## Deployment

Built for local use. For other devices: run behind an HTTPS reverse proxy with `HOST=0.0.0.0`, `COOKIE_SECURE=true`, and `GOOGLE_REDIRECT_URI` (and the URI registered at Google) set to the HTTPS address. Not tested in that setup.

## Known limitations

- See "Not tested live" above.
- Google events are cached from 90 days back; a calendar with more than about 200,000 cached occurrences stops syncing with a clear error.
- Repeating Google events: "this and following" is not offered.
- A time-block copy deleted inside Google is not recreated automatically.
- Date and time pickers are the browser's native ones (their format follows the browser language).
- Drag and drop needs a mouse or trackpad; on touch use the tap alternatives.
- Reminders need an open tab. Single user only. The assistant keeps a conversation only while its panel stays open.

## Assumptions

- Single-user, self-hosted, local-first.
- "Inbox" = open tasks with no planned day and no project. "Top three" = starred tasks, filled with labelled suggestions.
- A task's planned day follows its time block when it has exactly one block; the deadline never moves.
- Assistant: every change needs confirmation, including small local ones, so that nothing changes without a visible preview.
