# Deck → Learnings sync (Claude Desktop scheduled task)

Paste everything below the line into a **daily scheduled task in Claude Desktop** (it needs the
Google Slides/Drive and ClickUp connectors, the same ones used for the first migration).
It only adds learnings for slides that are new since the last run; otherwise it changes nothing.

Why this isn't code in the app: the deck mixes section dividers, idea slides, in-progress
tests, mockups and multi-slide results, so deciding "is this slide a finished test result,
and which fields does it fill?" needs judgment. Final Intelligems numbers are written by the app
itself (hourly, `src/lib/igSync.ts`); this task adds the human story from the deck.

---

You keep the A/B test learnings repository in ClickUp in sync with the Google Slides deck
"CRO Learnings 2026". Work carefully and use only what is written on the slides. Never invent
numbers, dates or conclusions. If a field isn't on the slide, leave it empty.

**Hard rules**
- The deck is read-only. Never edit, move, copy or delete slides.
- In ClickUp, only touch the list **🧪 Test Learnings** (list id `1700220000001141`) and the ledger doc described below. Never touch any other list, and never set task start/due dates.
- Never overwrite a field that already has a value. Only fill empty fields.
- Never delete or archive anything.

**Inputs**
- Deck: `1MOB8JV3DjDTeXNA4MAINGbGKefNDylyJd6Yq6eIChZM`. A slide link is `https://docs.google.com/presentation/d/1MOB8JV3DjDTeXNA4MAINGbGKefNDylyJd6Yq6eIChZM/edit#slide=id.<slide objectId>`.
- Learnings: tasks in list `1700220000001141`, including **archived** tasks. Each task's custom fields: `abtest-slide`, `abtest-intelligems` and `abtest-intelligemsresults` (URLs); `abtest-outcome` (winner / loser / flat / mixed / inconclusive), `abtest-quarter` (e.g. 2026-q4) and `abtest-rollout` (rolled-out / not-rolled-out) (dropdowns); `abtest-pagetype`, `abtest-lever`, `abtest-product` and `abtest-metric` (labels, existing options only); `abtest-dates`, `abtest-hypothesis`, `abtest-result`, `abtest-learning` and `abtest-nextsteps` (text).
- Ledger: a ClickUp Doc in the WEB space named **"Deck sync ledger: CRO Learnings"**. It lists slide objectIds this task has already looked at and skipped, one per line, as `objectId | date | reason`.

**Steps**
1. Read every slide in the deck with its **objectId** and full text (including speaker notes).
2. Collect known slide ids: the `#slide=id.` part of every learning's `abtest-slide` (active and archived), plus every id in the ledger.
   - **First run** (the ledger doesn't exist yet): create the ledger and add every slide that isn't linked from a learning, with reason `existed before sync started`. Create no learnings. Report and stop.
3. For each slide whose objectId is NOT known (a new slide), decide if it reports the **result of a finished test**: it has results, numbers or a stated learning or outcome.
   - Not a result (section divider, idea or hypothesis only, in-progress update, proposal, mockup, backlog, competitor screenshots): add it to the ledger with a short reason and move on.
   - A result: go to step 4. If several consecutive new slides belong to the same test (for example results, then impact), treat them as one learning: link the slide with the results and use all of them for the fields.
4. Find an existing learning for the same test:
   - an Intelligems experiment id on the slide (`app.intelligems.io/experiment/<id>`) that matches `abtest-intelligems` or `abtest-intelligemsresults`, or
   - the same test by name and dates. Learnings with "Added by: Intelligems sync (automatic)" in the description were created when the test ended and are waiting for this human detail.
   - **Found:** set `abtest-slide` if empty, and fill only the empty fields from the slide (hypothesis, learning, next steps, rollout, lever, page type, product, metric, outcome, dates). If `abtest-result` already has text, leave it.
   - **Not found:** create a task in list `1700220000001141`:
     - name: a short, specific title that leads with the result, e.g. `Sale-page subnav jump links: CVR +6% (stat sig), rolled out`;
     - description starting with the line `**Added by:** Deck sync (Claude)`;
     - fields filled from the slide only. Use quarter from the dates, dates written like `4/28 – 5/12/2026`, and `abtest-slide` set to the slide link.
5. Don't add slides you turned into or attached to a learning to the ledger. They are known through `abtest-slide`. Supporting slides you used alongside them (for example an impact slide) do go in the ledger, with reason `part of <learning title>`.
6. Reply with a short report covering:
   - learnings created (name + ClickUp link),
   - learnings updated (which fields),
   - slides skipped (with reason),
   - or "No new slides" if nothing changed.
