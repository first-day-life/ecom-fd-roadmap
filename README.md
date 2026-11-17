# firstday.com — Ecommerce Roadmap

A roadmap board that reads and writes **ClickUp** directly. It starts at the year level (12 month cards). Click a month to see its weeks, then expand a week into days, where you can drag a bar to move it or drag its edges to change its dates.

## Where the data lives

| What | Where |
|---|---|
| Roadmap items | Every list in a ClickUp folder (`CLICKUP_FOLDER_ID`), e.g. *Ecommerce 26-27*: Site Backlog, Current Sprint, AB Test Backlog, Idea Parking Lot |
| Requests | ClickUp tasks tagged `roadmap-request` (created in `CLICKUP_REQUEST_LIST_ID`). Approve = remove the tag. Reject = archive. |
| Accomplishments | Still a Google Sheet (unchanged) |

### How a task lands on the calendar

1. **Task start / due date** (ClickUp's native dates). These always win.
2. **Roadmap Start Date / Roadmap End Date** custom fields. Used only when the task has no start or due date. Drawn hatched.
3. **📅 Target Month** dropdown. Tasks with no dates show under *"Planned for <month> — no dates yet"*. Drag one onto a day to give it roadmap dates.
4. Nothing set → **Unplanned** (shown under the year view).

Dragging writes back to whichever source placed the item: native dates stay native, and roadmap dates stay roadmap dates.

Custom fields are matched **by name** on each list, ignoring case and emoji, so each list can differ. Pillar, Sprint and Big Swing are optional and show up automatically if you add fields with those names. Statuses come from each list.

"Archive" in the app archives the ClickUp task (restorable). Nothing is ever hard-deleted.

## Run locally

```bash
npm install
cp .env.local.example .env.local   # add your ClickUp token
npm run dev                        # http://localhost:3000
```

No token handy? Set `CLICKUP_MOCK=1` in `.env.local` to run against built-in sample data.

`/config` shows which lists were found, which roadmap fields each list has, and the task counts.

## Deploy (Netlify)

1. Import the GitHub repo in Netlify. Next.js is auto-detected (`netlify.toml` sets the build).
2. Add the environment variables from `.env.local.example`. At minimum: `ACCESS_TOKEN`, `CLICKUP_API_TOKEN`, `CLICKUP_FOLDER_ID`, `APPROVER_PASSWORD`.
3. Deploy, then open `/config` to verify.

ClickUp responses are cached on the server for 20 seconds (lists and fields for 5 minutes), so page loads stay fast and well inside Netlify's function timeout.

## Access (temporary token gate)

Until real authentication is added, the whole site (pages + API) sits behind one long shared token (`src/middleware.ts`):

- Set `ACCESS_TOKEN` (at least 32 characters; `openssl rand -hex 32`). In production the site **refuses to serve** without it.
- Share the link `https://<site>/?token=<ACCESS_TOKEN>`. The first visit sets a 30-day httpOnly cookie and strips the token from the URL.
- Scripts can send `Authorization: Bearer <ACCESS_TOKEN>` instead.
- Rotating `ACCESS_TOKEN` logs everyone out.
- Locally, leaving `ACCESS_TOKEN` empty disables the gate.

> ⚠️ This is a stopgap. Everyone shares one token, there's no per-user identity or audit trail, and anyone who has the link can edit those ClickUp lists. Replace it with real per-user auth.
