# Restore runbook

§18.3 requires this document by name: *"The restore runbook names who does it,
in what order, and how the application is pointed at the restored project."*
It also sets the standard the runbook has to meet — **"a backup that has never
been restored is a belief, not a control"** — so the last section is a
rehearsal record, not a checkbox.

Objectives, from §18.3: **RPO 1 hour, RTO 4 hours.** Both are deliberately
modest because the data is reconstructible: partners can repost a rate book in
a minute. Nothing below should be optimised at the cost of correctness.

---

## 1. Who does it

Fill these in before go-live. A runbook whose first column is blank fails at
02:00, which is the only hour it is ever read.

| Role | Name | Reached how | Owns |
|---|---|---|---|
| Restore lead | *(fill in)* | *(fill in)* | Runs the restore, calls the decisions in §3 |
| Deputy | *(fill in)* | *(fill in)* | Same authority; exists so the lead can be unreachable |
| Supabase owner | *(fill in)* | *(fill in)* | Org-level access to create a project and read backups |
| Vercel owner | *(fill in)* | *(fill in)* | Production environment variables and redeploys |
| Backbone contact | *(fill in)* | *(fill in)* | Tells partners and RMs what is happening, in plain words |

Only the restore lead changes production environment variables. Two people
editing them concurrently is how a restored system ends up pointed half at the
old project and half at the new one.

**Say something early.** §2's stated risk is that RMs revert to asking backbone
*and now also distrust the tool*. An outage handled silently costs more trust
than one announced badly. The backbone contact tells RMs "the board is down, do
not use a cached number, ask us" before the restore starts, not after it
finishes.

---

## 2. What is and is not in a backup

This is the section that decides whether a restore produces production or
something that merely resembles it.

**Comes back with the database**

- Every table, column, constraint, index, policy, function and view.
- All rate, submission, markup and audit data.
- The `pg_cron` schedule for the `raw_input` purge — it lives in migration
  `0024_schedule_raw_input_purge.sql`, not in dashboard state.

**Does NOT come back, and must be reapplied by hand**

- **Auth URL configuration** — Site URL and the redirect allowlist. Magic-link
  sign-in fails *silently and enumeration-resistantly* when these are wrong:
  §19/TM12 makes the response byte-identical, so a misconfigured allowlist and
  an unknown email look exactly the same from the application. This has already
  cost this project a debugging session once. Set it before testing sign-in.
- **SMTP credentials.** Supabase's built-in mailer has a low rate limit that is
  exhausted quickly during a rehearsal; without project SMTP, sign-in appears
  broken for reasons unrelated to the restore.
- **Self-signup disabled.** A fresh project re-enables it. Left on, anyone can
  mint a principal.
- **The JWT secret**, which is new. Every existing session is therefore invalid
  and every user signs in again. This is expected and acceptable — §19 has no
  passwords, so re-authentication is one email — but tell people it will happen
  rather than letting them read it as a second failure.
- **Vercel environment variables** (§4).

---

## 3. Choose the restore path

| Situation | Path |
|---|---|
| Data loss or corruption, project intact | **PITR** to a timestamp before the damage. Fastest, and the only path that meets RPO 1 hour. |
| Project lost, region incident, or PITR unavailable | **Rebuild into a fresh project** (§3.2). |

### 3.1 PITR

Supabase dashboard → Database → Backups → Point in Time. Restore to the last
timestamp *before* the damage, not to "now". Then skip to §5 — the project ref
has not changed, so §4 is not needed.

### 3.2 Rebuild into a fresh project

**Restore the schema from migrations, and the data from the dump — not the
schema from the dump.**

That is not a stylistic preference. The privilege lockdown that TM1 rests on is
made of `REVOKE`s, and a logical dump taken with `--no-acl` or `--no-owner`
restores the tables *without* them. The result looks correct, passes a smoke
test, and has silently re-opened `PUBLIC` access to partner rate data.
Restoring the schema from `supabase/migrations/` cannot drift that way.

This is safe to rely on because it is verified mechanically, not assumed:

```bash
node scripts/verify-rebuild.mjs
```

That applies every migration to a scratch database from scratch and
fingerprint-compares tables, columns, constraints, indexes, policies, functions
and views against live. It is the mechanical half of this rehearsal, and it
currently passes.

Order:

1. Create a new Supabase project in the same region. Note its project ref.
   *(A fresh Supabase project provides the `auth` schema, `auth.uid()` and the
   `extensions` schema before any migration runs. Our migrations depend on all
   three without declaring it — see the rebuild note in `spec-findings.md`.
   This is free on Supabase and absent on bare Postgres.)*
2. Set `DATABASE_URL` locally to the new project.
3. Apply the schema:

   ```bash
   node scripts/apply-migrations.mjs
   ```

4. Load data only, from the most recent dump:

   ```bash
   pg_restore --data-only --disable-triggers -d "$DATABASE_URL" <dump-file>
   ```

5. Reapply the dashboard settings listed in §2 — auth URLs, SMTP, self-signup.

---

## 4. Point the application at the restored project

Only needed for §3.2. Four variables change:

| Variable | New value |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | New project URL |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | New project anon key |
| `SUPABASE_SERVICE_ROLE_KEY` | New project service-role key |
| `DATABASE_URL` | New pooler connection string |

`NEXT_PUBLIC_SITE_URL` does not change if the domain does not.

**Then redeploy.** `NEXT_PUBLIC_*` variables are inlined into the client bundle
at build time. Changing them in the Vercel dashboard without triggering a new
deployment leaves the browser talking to the old project while the server talks
to the new one — a split brain that presents as intermittent, inexplicable
authorisation failures.

Set the service-role key in the Vercel dashboard directly. It is never pasted
into a terminal, a chat, a file, or this repository.

---

## 5. Verify — and what counts as verified

A restore is finished when the access matrix passes, not when the pages load.

```bash
npm run test
```

- **`tests/access/matrix.test.ts` and `tests/access/rpc-authorisation.test.ts`
  are the acceptance test.** T1–T23 exercise RLS and grants with real
  magic-link sessions, never a service-role query. Passing means the isolation
  TM1 describes survived the restore. A restored board that renders proves
  nothing about who can read it.
- **`tests/schema/invariants.test.ts`** includes the drift guard: the schema is
  what the migration files say it is.
- **T26** re-checks that no function is executable by `PUBLIC` — the property
  the ACL trap in §3.2 would have quietly destroyed.

Then, by hand:

1. Sign in as a staff principal. *If the link fails, re-read §2 before
   suspecting the restore.*
2. Open the board for a seeded pair. Rates render, ranked, with the indicative
   disclaimer.
3. Sign in as a partner principal. Submit one rate. It appears on the board.
4. Copy a quote. Confirm a `quote.copy` audit event was written.
5. Confirm the purge job is scheduled:

   ```bash
   psql "$DATABASE_URL" -c "select jobname, schedule from cron.job"
   ```

Tell the backbone contact when steps 1–5 pass. That, not the restore itself, is
the end of the incident.

---

## 6. Rehearsal record

§18.3: rehearsed **once before go-live and once per quarter**, into a scratch
project, **timed and written down**. Written down here.

| Date | Path | Who | Time to §5 passing | Within RTO 4h | Notes |
|---|---|---|---|---|---|
| 2026-08-27 | Schema only, scratch database | automated (`verify-rebuild.mjs`) | ~1 min | n/a | Mechanical half only. 26 migrations applied from scratch; 12 tables / 161 columns / 80 constraints / 37 indexes / 24 policies / 41 functions / 2 views identical to live. |
| *(pending)* | Full, fresh project | *(fill in)* | | | **Outstanding before go-live.** The data restore, the dashboard reconfiguration and §5 are untested by a human. |

### What is still a belief

Stated plainly, because §18.3's whole point is that an unrehearsed control is
not a control:

- **No nightly logical dump exists yet.** §18.3 requires one, retained 30 days,
  stored outside the Supabase project. Until it does, §3.2 has no input and the
  only real path is PITR.
- **PITR retention has not been confirmed** as enabled at 7 days or more.
- **A full restore has never been performed.** The schema half is proven; the
  data half, the dashboard reconfiguration and the timing are not.

The first two are dashboard and infrastructure work. The third is the rehearsal
itself, and it needs a human with the clock running.
