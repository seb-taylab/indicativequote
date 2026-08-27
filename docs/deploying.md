# Deploying to Vercel

The repository is ready to deploy. These steps have to be done by hand: the
Vercel MCP token could not create a project on the team (403 forbidden), and
two of the environment values are secrets that should never pass through a
chat transcript.

## 1. Create the project

Vercel dashboard → **Add New → Project** → import `seb-taylab/indicativequote`.

Vercel detects Next.js. Leave the build settings alone — `package.json` already
sets the build command to

```
next build && node scripts/assert-no-service-key.mjs
```

so §12.3's guard runs on **every deploy**, not just locally. If the
service-role key ever reaches the client bundle, the deploy fails rather than
shipping.

## 2. Environment variables

Set these in **Project Settings → Environment Variables**, for Production,
Preview and Development.

| Name | Value | Notes |
|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | `https://<project-ref>.supabase.co` | Safe in the browser |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | the publishable key | Safe in the browser; RLS denies `anon` everything (T21) |
| `NEXT_PUBLIC_SITE_URL` | the deployment URL | Used to build the magic-link redirect |
| `SUPABASE_SERVICE_ROLE_KEY` | the service-role key | **Secret.** Never add a `NEXT_PUBLIC_` prefix to this |

All four are in the Supabase dashboard under **Project Settings → API**.

> The `NEXT_PUBLIC_` prefix is what puts a value in the browser bundle. That is
> correct for the first three and catastrophic for the fourth — the
> service-role key bypasses RLS entirely. The build guard exists because this
> is an easy mistake to make once.

## 3. Supabase Auth configuration

**Authentication → URL Configuration**:

- **Site URL** — the production deployment URL.
- **Redirect URLs** — add `https://<deployment>/auth/callback`, and
  `http://localhost:3000/auth/callback` for local work.

Sign-in will fail silently without these: Supabase refuses to redirect to an
unlisted URL, and §19's byte-identical response means the user sees the same
"check your inbox" message either way.

**Authentication → Providers**: email is enough. Leave passwords disabled —
§19 is explicit that there are none anywhere.

`[A-7]`: if Microsoft SSO turns out to be available for an externally reachable
app, staff sign-in swaps to it with no schema change. Partner sign-in stays on
magic link regardless.

## 4. First admin

The database has no principals until one is created, and `invite_staff` is
admin-only — so the first admin cannot be invited through the application.
Create it once, directly:

```sql
insert into public.principals (email, kind, status)
values ('you@metacomp.example', 'staff', 'invited')
returning id;

insert into public.staff_profiles (principal_id, role)
values ('<the id above>', 'backbone_admin');
```

Then sign in normally. `record_sign_in` binds the auth user, promotes
`invited` to `active`, and writes `access.signin`. Every subsequent principal
is created through the application.

## 5. Scheduled work

§18.4 requires `raw_input` older than 90 days to be nulled and stamped, and
§18.2 alerts if the job has not run in 25 hours. Enable `pg_cron` on the
Supabase project and schedule:

```sql
select cron.schedule(
  'purge-raw-input', '17 3 * * *',
  $$ select app.purge_raw_input(90) $$
);
```

## 6. Before go-live

These are §1.5 and §21.2, not optional:

- [ ] **`[A-1]` confirmed in writing, per partner.** No partner reaches the
      board until `convention_confirmed_at` is set, and the build cannot
      discharge this. If the assumption is wrong, every price inverts.
- [ ] Each partner's agreement permits showing their rates to MetaComp staff.
- [ ] `T1`–`T23` run green against a real project with real sessions.
- [ ] A restore from backup rehearsed, **timed** and written down (§18.3).
      Runbook: [restore-runbook.md](restore-runbook.md). Both mechanical halves
      pass -- `npm run db:verify-rebuild` (schema from migrations) and
      `npm run backup:verify` (data round-trip). What is outstanding is the
      human half: a real restore into a fresh project, with the dashboard
      reconfiguration of §2, against a clock.
- [ ] Point-in-time recovery enabled, 7 days minimum. **Not yet confirmed.**
- [ ] A nightly logical dump scheduled, retained 30 days, stored outside the
      Supabase project. The mechanism is proven (`npm run backup`) but nothing
      runs it on a schedule and no destination is configured. Use `pg_dump` for
      the production job. **Never** store a dump as a GitHub Actions artifact:
      on a public repository anyone can download it.
- [ ] Repository secrets set so CI runs the security tests -- see §7. Until
      they are, a green CI run means types, lint, unit tests, build guards and
      the dependency scan passed, and nothing about who can read whose rates.
- [ ] SMTP configured, and self-signup disabled (F18, F19). Sign-in cannot work
      reliably without the first, and the second lets anyone mint a principal.
- [ ] **Not implemented, and accepted or scheduled deliberately:** TM10's
      new-device alerting and TM14's edge rate limiting. Both need
      infrastructure this build does not configure. Neither is a code gap that
      can be closed by pretending otherwise.
- [ ] Seed data removed from any project that will hold real rates. The seed
      refuses to run where non-demo partners exist, but it does not remove
      itself.

## 7. Continuous integration

`.github/workflows/ci.yml` runs on every push to `main` and on every pull
request. It is split by what needs credentials.

**Runs always, on forks included, with no secrets:** typecheck, ESLint, the
unit tests, `npm audit` (failing on high and critical), and a build — the build
is there because `npm run build` is what runs the two guards §12.3 and §12.7
require to fail a build, not for the artefact.

**Runs only when repository secrets are present:** the access matrix, RPC
authorisation, the golden tests, the schema invariants, the degraded states,
and the §18.1 rebuild check. §20.2 forbids testing any of it with a
service-role query, so these need a real project and real magic-link sessions.

### Repository secrets

Settings → Secrets and variables → Actions:

| Secret | Value |
|---|---|
| `DATABASE_URL` | Pooler connection string for the test project |
| `NEXT_PUBLIC_SUPABASE_URL` | Test project URL |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Test project anon key |
| `SUPABASE_SERVICE_ROLE_KEY` | Test project service-role key |

**Point these at a staging project, not at production.** These tests create and
destroy principals, invite and revoke staff, and write rates. §18.1 already
calls for "a staging project with seed data" and this is what it is for. F21
was a test corrupting shared state; the workflow serialises runs against one
project with a concurrency group, but serialising damage is not preventing it.

**Without `DATABASE_URL`, the security tests do not run**, and the workflow says
so in a step annotation and in the run summary rather than passing quietly. A
green tick on such a run means the types, the lint rules, the unit tests, the
build guards and the dependency scan passed — nothing about who can read whose
rates. That is expected on a fork's pull request, which never receives secrets.
It is not expected on `main`.

## A note on plan limits

The team is on the **hobby** plan, where Deployment Protection is unavailable.
The deployment URL is therefore reachable by anyone who has it.

That is not a data leak. RLS denies `anon` every table and view, T21 asserts
it, and §5 is explicit that "route guards are convenience; the database is the
boundary". What is publicly visible is the login page. If you would rather it
were not visible at all, Deployment Protection on a paid plan is the control,
not application code.
