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
3. Nothing set → **Unplanned**. The app does not read or write ClickUp's 📅 Target Month field.

Dragging writes back to whichever source placed the item: native dates stay native, and roadmap dates stay roadmap dates.

Custom fields are matched **by name** on each list, ignoring case and emoji, so each list can differ. Pillar, Sprint and Big Swing are optional and show up automatically if you add fields with those names. Statuses come from each list.

"Archive" in the app archives the ClickUp task (restorable). Nothing is ever hard-deleted.

## 🧪 Live tests (Intelligems)

The **🧪 Tests** tab lists live and paused Intelligems A/B tests, longest-running first, with days running, Intelligems' estimated test length and the traffic split. It reads from the Intelligems External API (`GET /v25-10-beta/experiences-list`, read-only, cached 5 min). Set `INTELLIGEMS_API_KEY` (Intelligems → Integrations → Intelligems External API → Enable).

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
2. Add the environment variables from `.env.local.example`. At minimum: `CLICKUP_API_TOKEN`, `CLICKUP_FOLDER_ID`, `APPROVER_PASSWORD`. Enable **Identity** with the **Google** provider (see Access below).
3. Deploy, then open `/config` to verify.

ClickUp responses are cached on the server for 20 seconds (lists and fields for 5 minutes), so page loads stay fast and well inside Netlify's function timeout.

## Access — Google sign-in (Netlify Identity)

The whole site and API require a Google sign-in through **Netlify Identity**, limited to company email domains (`src/middleware.ts`).

- Netlify → **Identity**: enabled, with **External providers → Google** turned on.
- `ALLOWED_EMAIL_DOMAINS` (default `firstday.com`): only these domains get in. `ALLOWED_EMAILS` can add individual addresses.
- Signed-out visitors see a "Sign in with Google" page, and the API returns 401. Sessions live in httpOnly cookies and refresh automatically.
- The middleware re-checks each session token with Identity (cached for up to 5 minutes per server instance). Netlify's own `/.netlify/*` endpoints are left untouched.
- Locally (`npm run dev`) sign-in is off unless you set `AUTH_REQUIRED=1`. Netlify Identity only exists on the deployed site.
- `/auth/me` returns the signed-in email; `/auth/logout` signs out.
