# Known limitations and failure scenarios

Honest list of what is missing or weak, followed by what happens when things fail.

## Limitations

**Product**
- No sign-up, password reset, SSO or MFA; users are seeded or added to a team by an admin who knows the e-mail of an existing user.
- Notifications are in-app only (no e-mail/Slack). No attachments, SLA timers, saved views or audit export.
- Full-text search uses PostgreSQL's `simple` configuration: prefix matching works, stemming and typo tolerance do not.
- "Needs attention" shows up to 5 items per group with the true total; computing the total costs time proportional to the number of matching
  items (≈100 ms at 50 000 items for an admin). A cap ("1000+") or a short cache would be the next step.
- The stale scan flags at most 200 items per run (it runs repeatedly, so a large backlog drains over a few minutes).

**Security / operations**
- Login rate limiting (10 failures / 15 min per key) is **in memory**: with several API instances the effective limit is multiplied.
- Demo passwords are public and seeded users are for development only; run `npm run seed` only in development. Set `COOKIE_SECURE=true` behind HTTPS.
- No CI pipeline, no structured metrics/tracing (JSON logs with a request id only), no backup/restore tooling.
- Single PostgreSQL primary: if it is down, the app is down (the health endpoint reports 503).

**Testing**
- Backend behaviour is covered by 29 automated tests on a real database. The UI has **two** Playwright scripts (not part of `npm test`):
  `ui-smoke.mjs` (login, Needs attention, claim conflict) and `ui-redesign.mjs` (overflow at 3 widths, mobile drawer, explained blocked actions,
  version conflict inside the edit dialog, member-removal confirmation, skip link). Not covered by automated browser tests: the
  transition/assign/priority dialogs, notification read-state, "Load more", the new-item form's duplicate warning, and the live "changed by
  someone else" banner (the server side of each is tested).
- The UI was exercised in **Chromium only**, at three widths (1280, 820, 390 px). It was not tried in Firefox or Safari, on a physical phone or
  tablet, or with a screen reader. Colours were chosen for contrast, but no automated contrast audit was run.
- Docker files have not been executed by the author (their commands were verified individually).
- No load test beyond the single-request timings in [PERFORMANCE.md](PERFORMANCE.md); concurrency was tested at 20 simultaneous claimers, not hundreds.

## Failure scenarios

| Scenario | What happens | Evidence |
|---|---|---|
| Two people claim the same item | One `UPDATE` succeeds; the others get `409 ALREADY_CLAIMED` with the owner's name; exactly one `claimed` event | test: claim race (20 concurrent) |
| User double-clicks / retries after a timeout | Same `Idempotency-Key` → original response replayed (`Idempotent-Replay: true`), no duplicate; different body with the same key → `422` | test: idempotent create (also 10× concurrent) |
| Editing an old version | `409 VERSION_CONFLICT` + current state; nothing written; UI offers to re-apply | test: stale version |
| Request fails half-way | One transaction: item, event and outbox job all roll back together | test: audit atomicity |
| Someone tries to rewrite history | A trigger rejects `UPDATE`/`DELETE` on the events table | test: append-only |
| Handler throws (e.g. transient error) | Job retried with exponential back-off + jitter; `dead` after max attempts, with `last_error` stored | test: retry/back-off/dead-letter |
| Worker crashes mid-job | Effect + completion are one transaction, so nothing half-done is kept; the job is re-queued after the visibility timeout | test: crash recovery |
| Same job delivered twice | `UNIQUE (user_id, event_id)` → still one notification per user and event | test: duplicate delivery |
| Two workers poll at once | `SKIP LOCKED`: a job is processed by one worker only | test: two workers |
| Worker is down | User actions still succeed; notifications are delayed; the backlog is processed when the worker returns (jobs live in the database) | by design (outbox); not separately tested |
| Two stale-scan runners | `SKIP LOCKED` + `stale_notified_at`: each item flagged once; activity clears the flag | test: stale scan |
| Member removed / role changed | Principal is reloaded each request → effective on the next request; items are released or removal refused (`MEMBER_HAS_WORK`); last admin cannot be removed | test: membership |
| Request for another team's item | `404` (not `403`) on every endpoint | test: resource-level authorization |
| Brute-force login | `429 RATE_LIMITED` with `Retry-After` after 10 failures (per process) | implemented; not load-tested |
| Live-update (LISTEN) connection drops | Hub reconnects with back-off and broadcasts `resync` so clients refetch; clients are removed on disconnect | implemented; the reconnect path is not tested |
| Browser loses the SSE stream | The page keeps working; data refreshes on navigation/actions | by design |
| Database slow/unavailable | Postgres timeout/lock errors map to `503`; `/api/health` checks the DB | mapping implemented; not fault-injected |
