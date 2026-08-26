# Findings against rate-hub-spec-v2-1

Defects and open decisions found while implementing the specification. Each was
found by executing the spec's own DDL against the real project, not by reading.

Status key: **OPEN** needs a decision from the spec owner · **CLOSED** fixed in
the build, recorded here so the fix is not mistaken for drift.

---

## F1 — `ALTER DEFAULT PRIVILEGES` does not close the hole §12.2 says it closes

**Severity: high. Status: CLOSED in migration 0006.**

§12.2 states: *"Every function created after this point starts with no execute
privilege and is granted explicitly."* The Appendix lists this as a V2 → V2.1
fix, and T26 exists to prove it.

It does not hold on Supabase. Verified by creating a function after applying
0001 exactly as specified:

```
public._t26_probe  ->  {=X/postgres,postgres=X/postgres,service_role=X/postgres}
app._t26_probe     ->  (null: built-in default, PUBLIC has EXECUTE)
```

The leading `=X` is PUBLIC holding EXECUTE. Two separate causes:

1. Postgres re-applies the built-in default for functions on top of the stored
   `pg_default_acl` row, so revoking from PUBLIC in default privileges does not
   suppress it.
2. For the freshly created `app` schema, `ALTER DEFAULT PRIVILEGES` recorded no
   row at all, so the built-in default applied unmodified.

There is also a Supabase-specific hole the spec does not mention: the platform's
`postgres`-owned default ACL grants EXECUTE to `anon` and `authenticated`
**by name**, not via PUBLIC, so §12.2's `revoke ... from public` would not have
removed them even if it worked.

**Consequence had this shipped as written.** Every RPC in §13 — the entire write
surface, `invite_staff` and `create_markup_version` included — would have been
executable by `anon` and by any signed-in user from the moment of creation, with
the role check inside each function as the only control. That is exactly the
class of defect §12.2 says cannot recur.

**Fix.** Migration 0006 installs an event trigger that revokes EXECUTE from
PUBLIC and `anon` on every function created in `public` or `app`, at creation.
The guarantee is structural, not a convention a future migration must remember.
`tests/schema/invariants.test.ts` asserts it with a function created after
migration, and asserts the trigger is still installed and enabled.

**Note on T26 as written.** The natural implementation of the assertion —
matching the ACL text for `=X` — is wrong: it also matches `postgres=X/postgres`
and reports a false failure. PUBLIC must be identified as grantee OID `0` via
`aclexplode()`. The test does this.

---

## F2 — The band exclusion constraint refuses §10.4's own worked example

**Severity: high. Status: DECIDED and IMPLEMENTED — see D-F2 below.**
Option 1 was chosen. `submit_rates` refuses touching bands with a message
naming the disputed ticket and how to fix it; verified in migration 0015.

§10.4 motivates D16 with: *"a partner quoting 1392 up to 100k and 1393.5 above
it has two current rows, not one."*

That submission is refused by the spec's own DDL. With
`numrange(min_size, max_size, '[]')` the two bands are `[0, 100000]` and
`[100000, ∞)`, which share the endpoint 100,000, so `rates_bands_no_overlap`
rejects the transaction. Verified:

| Bands | Outcome |
|---|---|
| `[0,100000]` + `[100000,∞)` — the spec's example | **REFUSED** |
| `[0,100000]` + `[100000.000001,∞)` | ACCEPTED |
| `[100000,∞)` + `[500000,∞)` — a genuine overlap | REFUSED (correct) |
| two current `unconfirmed` rows | REFUSED (correct) |
| insert-then-supersede on one band | ACCEPTED (correct — §12.5 executes) |

So D16 and `[A-2]`, the entire reason bands exist, cannot express the case they
were introduced for. Every partner who quotes a hurdle at a round number hits
this on their first submission.

The DDL is not itself wrong — it correctly refuses real overlaps. What is
undecided is what a touching boundary means and who resolves it.

**Options.**

1. **Keep `'[]'`, resolve in the grid.** `max_size` stays "largest ticket", which
   matches how a partner speaks. `submit_rates` rejects a touching boundary with
   a specific message, and the grid offers to set the upper band's floor one
   minor unit above. Human semantics preserved; one extra confirmation.
2. **Switch to `'[)'`.** `[0,100000)` + `[100000,∞)` tile perfectly. But
   `max_size` then means "first ticket *above* the band", so a partner who says
   "up to 100k" and enters 100000 silently excludes 100,000 itself — the single
   most likely round ticket at the hurdle. Mis-prices the exact case A-2 cares
   about.

**Recommendation: option 1.** Option 2 trades a visible error for a silent
mispricing at the amount most likely to be traded.

Built as specified (`'[]'`) pending the decision, since option 1 needs no schema
change and option 2 does.

---

## F3 — `[A-1]` remains the assumption that decides correctness

**Severity: critical (inherited). Status: OPEN by design — gate is built.**

Not a defect in the spec; recorded because the build cannot discharge it. §1.4
A-1 assumes `USD/NGN 1392 | 1394` means lower = partner's bid. Golden test 1
*pins* the convention; it cannot *validate* it. If the assumption is false,
every direction mapping inverts and every client price is wrong in a way no
test in this repo will catch.

The `convention_confirmed_at` gate is implemented and enforced: a partner
without it shows as `unavailable` and can never rank. Verified through a real
session in `tests/access/matrix.test.ts`.

**This still requires written confirmation per partner before go-live (§1.5).**

---

## F4 — `staff_profiles_self` is safe as specified (not a defect)

**Severity: none. Status: CLOSED, verified.**

Recorded because it looks like a leak on a first read and will come up again in
review. §12.6's representative policy is

```sql
create policy staff_profiles_self on public.staff_profiles for select
  using (principal_id = app.principal_id());
```

with no role guard, which appears to grant a partner its own `staff_profiles`
row and so contradict that table's *"Partner principal: none"* column and T4.

It does not. `staff_profiles` holds only staff principals — the composite
foreign key `(principal_id, kind) references principals(id, kind)` with
`check (kind = 'staff')` makes that structural. A partner's `principal_id` can
therefore never equal any row's, and the policy matches nothing for a partner.
D11 is doing the work.

The build adds `and app.staff_role() is not null` anyway. It is redundant
today, and it stays redundant only while D11 holds — which is exactly when it
would start to matter. T4 asserts the outcome either way.

---

## F5 — The repository is public, deliberately

**Severity: medium. Status: DECIDED — public, under the rule below.**

`github.com/seb-taylab/indicativequote` is public by the owner's decision, on
the condition that no sensitive content reaches it.

That makes the following a standing rule for every commit, not a one-time
cleanup:

- **No credentials.** `.gitignore` covers `.env*`. `.env.example` carries
  placeholders only — no project ref, no publishable key, no connection string.
  The publishable key is designed for browser exposure and RLS denies `anon`
  everything (T21), but the project address is not handed out for free.
- **No partner is ever named.** Not in code, tests, fixtures, seed data or
  commit messages. §18.1's seed partners are `Demo Alpha` and `Demo Beta`.
- **No real rate book.** The one exception is golden test 1, which needs the
  observed `USD/NGN 1392 | 1394` block to be worth anything at all — it is the
  test that pins `[A-1]`. It appears unattributed, and a liquid pair's mid is
  publicly observable regardless.
- **No `raw_input`, no client IP, no user agent, no principal e-mail** in any
  committed fixture or sample.

What the repository does publish is the schema, the RLS matrix and §18.5's
threat model. None of that is a vulnerability on its own — the design is meant
to survive being known — but it removes an attacker's need to guess the shape
of the system. The controls that matter are enforced in the database and
asserted by T1–T26, not by obscurity.

---

## D-F2 — Band adjacency: decision

**Recorded 2026-08-26. Resolves F2 above.**

Option 1: keep `numrange(..., '[]')`, and treat a touching boundary as a
partner-correctable error.

- `max_size` keeps meaning "largest ticket", which is how a partner speaks.
- `submit_rates` refuses two bands that share an endpoint, naming both and the
  amount in dispute, rather than guessing which band owns it.
- The grid offers to raise the upper band's floor by one minor unit, **visibly**
  — the partner sees and confirms the changed number.

Rejected: `'[)'`, because a partner entering "up to 100k" would then silently
exclude 100,000 itself, mis-pricing the exact hurdle `[A-2]` is about. Rejected:
a silent auto-nudge, because altering a partner's stated numbers without telling
them is how a rate board loses the trust §2 says decides the outcome.

No schema change. Lands with `submit_rates` in step 4.

---

## F6 — The registry can never admit a new currency

**Severity: medium. Status: CLOSED — additive RPC.**

§13.2 gives `register_currency_pair(p_base, p_quote)` but no way to add a
currency, and `currency_pairs` has foreign keys to `currencies(code)`. As
specified, `register_currency_pair` can only ever reference currencies the
database was seeded with, and there is no seed defined either — §18.1 covers
seed *partners and rates*, not the currency registry.

So on a fresh production database the first call to `register_currency_pair`
fails on a foreign key, and nothing in the spec's RPC surface can fix it. §13
is explicit that it is the complete write surface: *"If an operation is not
there, it cannot happen."*

**Fix.** `register_currency(p_code, p_name, p_kind, p_minor_units)`, admin-only,
same audit shape as its sibling, action `registry.add_currency`. Normalises to
uppercase and trims, so `' usd '` and `'USD'` cannot both be registered.

---

## F7 — Audit events in one transaction are not orderable

**Severity: low. Status: CLOSED — index and ordering rule.**

`audit_events.occurred_at` defaults to `now()`, which is **transaction start
time**, not statement time. §13 requires every RPC to write its audit event in
the same transaction as its effect, so any RPC writing more than one event —
or any transaction calling more than one RPC — produces events that are
indistinguishable by timestamp.

Observed: `partner.create`, `partner.set_policy` and `partner.confirm_convention`
written in one transaction came back ordered *confirm, set_policy, create*. The
sort had nothing to break the tie with, and §11.7's index is on
`(occurred_at desc)` alone.

An audit trail that cannot say which of two events came first is weaker than it
looks, and §16.3's audit page is reverse-chronological.

**Fix.** `id` is `bigserial` and monotonic, so it is the tiebreaker. Added
`(occurred_at desc, id desc)` indexes, and every read of `audit_events` MUST
order by both. `occurred_at` is left as specified — moving it to
`clock_timestamp()` would make an event's stamp disagree with the transaction
it belongs to, which is a worse trade.

---

## N1 — Supabase advisor warns on every RPC. Expected; do not "fix" it.

**Severity: none. Status: NOTED.**

`get_advisors(security)` reports
`authenticated_security_definer_function_executable` for every function in §13,
e.g. *"`public.create_partner` can be executed by the `authenticated` role as a
`SECURITY DEFINER` function"*.

This is the specified design, not a defect. §13: *"Each is granted to
`authenticated` explicitly; the role check inside the function is the
authorisation."* D2 makes RPC the only write path, so the RPCs must be
reachable by signed-in users; what stops an RM creating a partner is
`app.require_staff()` inside the function, not the grant.

Verified by execution, impersonating real roles:

| Caller | `create_partner` | `confirm_partner_convention` | `set_partner_status` |
|---|---|---|---|
| `backbone_admin` | OK | OK | OK |
| `rm_viewer` | refused 42501 | refused 42501 | refused 42501 |
| anonymous | refused 42501 | refused 42501 | refused 42501 |

**Revoking these grants to clear the warning would break every write path in
the application.** The warning is only actionable if a function ever lacks its
`app.require_staff()` / `app.require_partner()` guard — which is what the
per-RPC authorisation tests exist to catch.

---

## N2 — What actually enforces T18

**Severity: none. Status: NOTED, with a guard kept deliberately.**

§13.2 requires `revoke_staff` to refuse *"the last active `backbone_admin`"*,
and T18 tests it. Implementing both that and the self-refusal exposes something
worth writing down: **the count guard is unreachable for a non-self target.**

`app.require_staff(['backbone_admin'])` admits only an *active* admin. So if the
target is a *different* active admin, there are necessarily at least two active
admins and the count can never be `<= 1`. The property T18 names is actually
enforced by the **self-revocation refusal** sitting above it.

The count guard is kept anyway. It becomes load-bearing the moment anyone
relaxes the self check or widens who may call `revoke_staff` — precisely the
change a reviewer would otherwise wave through, since the test would still pass
without it.

The same reasoning applies to `set_staff_role`, where demotion is the other
route to zero admins.

**A bug this surfaced.** Both guards originally tested the count of active
admins without checking whether the *target* was active, so revoking or
demoting an **invited** admin — one who has never signed in — was refused with
"that is the last active backbone_admin", about a principal that is not active
at all. An admin who mistyped an address while inviting a colleague could not
withdraw the invitation until a second admin was appointed *and had signed in*.
Fixed in 0013; the guard now requires the target to be active.

---

## F8 — §4.1 and §12.6 disagree on what `rm_viewer` sees of markup

**Severity: low. Status: CLOSED — §12.6 followed, as the normative text.**

Two sections give different answers for the same table.

§4.1's permission matrix: `Markup versions | rm_viewer: applied value only`.

§12.6's RLS matrix: `markup_versions | Partner: none | Staff: select all`, with
the representative policy `using (app.staff_role() is not null)` — which
includes `rm_viewer`.

§0 settles precedence: sections 10 to 17 "**are** the specification", so §12.6
governs and `rm_viewer` can read `markup_versions` in full.

That is also the only reading that works. §7 requires the board's markup control
to be *"adjustable only within the version's band"*, so the RM's own screen has
to know `min_bps` and `max_bps`. Under §4.1's stricter reading the control
could not be built.

No threat is created. TM2 is *"Partner learns MetaComp's markup"* — partners,
not RMs, and the partner policy is still absent by design (T3). An RM already
sees the client rate and can infer the markup from it.

`board_rates` returns the active version's band to staff for exactly this
reason.

---

## F9 — `board_rates` returned 40 decimal places

**Severity: low. Status: CLOSED.**

`partner_bid * (1 - m/10000)` in `numeric` produces full working scale, so a
client rate came back as `1393.50000000000000000000000000000000000000`.

Not a correctness bug — the value is right — but §12.7 sends these across the
wire as text for a person to read, and 40 digits of spurious precision is an
invitation for someone downstream to "tidy it up" with a float, which is the
one thing §12.7 exists to prevent. `app.client_rate` now rounds to 14, the
scale of `rates.partner_bid`.

---

## F10 — §9's "recent failures" cannot come from `rate_submissions`

**Severity: medium. Status: OPEN — needs a telemetry decision.**

§9 requires the health page to report *"Recent failures — submissions in the
last 24 hours with `error_count > 0`, with the reasons"*, and §18.2 alerts when
`submit_rates` fails *"more than 2 for one partner in an hour"*, because *"a
partner hitting errors silently stops using the product"* — which is the
adoption risk §2 says decides the outcome.

Neither can be satisfied from `rate_submissions`. §6.4 makes a submission
atomic: a batch that fails validation **raises, and the transaction is
discarded**, so no envelope row survives. A failed submission leaves no trace
in the database at all. Verified: a batch containing a crossed rate wrote zero
rows, envelope included.

`error_count` can therefore only ever be `0` for a successful submission, and
the failure signal the operator most needs — a partner repeatedly bouncing off
validation — is exactly the one the table cannot hold.

The two are in direct tension: making failures visible in the database would
mean writing the envelope outside the transaction, which breaks atomicity.

**Options.**

1. **Application telemetry.** The route that calls `submit_rates` records
   failures to the error tracker and a counter, and the health page reads that.
   Keeps §6.4 intact. §18.2's exclusion still applies: no rate values and no
   `raw_input` in logs.
2. **A separate, autonomous failure log.** A small table written by a
   `SECURITY DEFINER` function in its own transaction, so a rollback of the
   submission does not roll back the record of the attempt. More faithful to
   §9 and queryable, at the cost of a table the spec does not define.

**Recommendation: option 2**, because §9 asks the health page to show the
reasons, and option 1 puts that signal somewhere an operator does not look.

`partner_health()` returns `recent_failures` from the table as specified, so
the shape is right; today it is always empty, and the migration says why.

---

## F11 — A principal could be invited and never sign in

**Severity: high. Status: CLOSED — migration 0021.**

§19 says *"On first click, `auth_user_id` and `first_seen_at` are set."* §11.7
lists `access.signin` and `access.signin_denied` among the audited actions.

But §13 — *"the complete write surface. If an operation is not there, it cannot
happen"* — contains no operation that does either, and D2 means `principals`
accepts no direct `UPDATE` from any application role. The invite RPCs create a
principal with `auth_user_id` null and status `invited`; nothing in the spec
can ever fill it in.

So as specified, every invitation is a dead end: the person receives a magic
link, Supabase Auth accepts it, and the application resolves them to no
principal at all.

**Fix.** `sign_in_allowed(email)` and `record_sign_in(auth_user_id, email)`,
neither granted to `authenticated` — they are called from the server-side auth
route with the service-role key, which is the only context where the caller
holds a session but is not yet a resolvable principal. `record_sign_in` binds
the auth user, stamps first/last seen, promotes `invited` to `active`, and
writes `access.signin` in one transaction.

`sign_in_allowed` also carries TM12: it returns only a boolean and records the
denial itself, so the route can answer identically whether or not the address
is known. `requestMagicLink` has a single success return and never branches its
message.

---

## F12 — `script-src 'self'` renders the whole application inert

**Severity: critical. Status: CLOSED — middleware nonce.**

§18.5 requires *"a CSP denying inline script"*. Implemented literally as
`script-src 'self'`, that also denies **Next.js's own bootstrap and
flight-data scripts**, which are inline by construction.

The result is the worst shape a bug can take: the application
**server-renders perfectly and never hydrates**. Observed on the running app —
the board displayed the right partners, the right bands, correct ranking, the
correct direction-dependent header and correct markup arithmetic, and
`Copy quote` silently did nothing. No error, no broken layout, nothing an
RM would report beyond "the button doesn't work".

The same failure would have made the submission grid inert: `Parse`, `Add row`,
every field and `Submit` are client-side. A partner would have seen a textarea
that does nothing.

An RM who believes they copied a quote that was never composed and never
recorded is exactly the failure §8 exists to prevent — *"the `quote.copy` event
is the authoritative record of what MetaComp quoted"*, and there would have
been no event.

**Fix.** The CSP moved from a static `next.config` header to `middleware.ts`,
which mints a fresh nonce per request, passes it on the request headers so
Next.js stamps its own scripts, and sets it on the response so the browser
enforces it. `'strict-dynamic'` lets those trusted scripts load their chunks
without whitelisting origins. `'unsafe-eval'` is added in **development only**,
for the React refresh runtime, and is absent from production.

The spec's intent is preserved exactly: no arbitrary inline script runs. What
changed is that the application's own scripts are now distinguishable from an
injected one, which `'self'` alone cannot express for inline content.

**Verified deterministically**, because a browser pane could not be relied on:

```
header nonce           : NjRkYjVhOTMt…
inline <script> tags   : 11
  carrying that nonce  : 11
distinct nonces in html: exactly one, equal to the header's
```

**This class of defect is invisible to server-side tests.** Every RPC test, and
every one of T1–T26, passes against a completely inert front end. Worth an
explicit hydration check in the acceptance run — §21.2's product criteria
("a partner submits six rates from a pasted block in under sixty seconds")
cover it only if they are exercised in a real browser.

---

## F13 — Seeding `auth.users` by SQL breaks the Auth admin API project-wide

**Severity: high. Status: CLOSED — seed fixed and rows backfilled.**

§18.1 requires seed data covering every state, and a seed that has to create
principals must create `auth.users` rows. Inserting them with the obvious
column set — id, email, timestamps, metadata — leaves
`confirmation_token`, `recovery_token`, `email_change` and
`email_change_token_new` **NULL**.

GoTrue scans those columns into Go `string` values. A NULL makes the scan fail,
and because the admin list query reads *every* row, **one bad row breaks
`auth.admin.listUsers` for the entire project** — including for users the seed
never touched.

Observed: after seeding five demo users, every `listUsers` call returned
`Database error finding users`. The five seeded rows had the four columns NULL;
every user created through the Auth API had them as `''`.

The failure is badly behaved in two ways. It is **remote from its cause** — the
error surfaces in the test harness creating unrelated users, not in the seed —
and it is **intermittent by path**: `createUser` succeeds, so anything that
never falls back to `listUsers` passes. The access suite passed when run alone
and failed only in a full run.

**Fix.** `supabase/seed/seed.sql` sets all eight token columns to `''`
explicitly, as the Auth API itself does. Existing rows were backfilled with
`coalesce(col, '')`.

**Rule.** Any direct write to `auth.users` must set every token column
explicitly. Preferring `auth.admin.createUser` avoids the problem entirely and
is the right default wherever a seed can afford the round trips.

---

## F14 — `.gitignore` did not cover a backup of an env file

**Severity: high (in a public repo). Status: CLOSED.**

The original pattern was `.env`, `.env.local`, `.env.*.local`. None of those
match `.env.local.bak`, which is exactly what a careless edit — or a tool
making a safety copy before rewriting `DATABASE_URL` — produces. In this
repository that file holds a live database password, and F5 makes the
repository public.

Caught by `git check-ignore` before any commit; no secret was ever staged,
committed or pushed.

**Fix.** `.env.*` with a `!.env.example` negation, plus `*.env`, `*.pem`,
`*.key`. Verified against `.env.local.bak` and `.env.production.backup`.

**Worth keeping as a habit:** run `git check-ignore -v <file>` on anything
holding a secret, rather than trusting a pattern to be broad enough.

---

## F15 — Decimals reached the browser as JSON numbers on the partner pages

**Severity: high. Status: CLOSED — views emit text, and `dec()` now refuses a number.**

§12.7 states the failure exactly: *"PostgREST serialises `numeric` as a JSON
number, and JavaScript parses every JSON number as a binary double — so a rate
can lose precision on the way to the browser without a single float appearing
in the schema."*

Rule 1 names **RPCs**, and every RPC complied — `board_rates` and
`record_quote_copy` cast every decimal to `::text`. But the partner pages read
`v_current_rates` and `rates` **directly through PostgREST**, which is the same
boundary with the same defect. A partner's own rates were arriving as binary
doubles. §11.8's normative view definition returns `numeric`, so building it as
specified produced the very outcome D13 forbids.

**How it was found, which is the interesting part.** Not by a precision test —
by the axe scan reporting `html-has-lang` on `/partner` and `/partner/history`.
Those pages were returning `<html id="__next_error__">`: a 500. The accessibility
violation was a symptom. The underlying crash was
`value.startsWith is not a function` in `dec()`, because it had been handed a
number.

**The crash was luck.** Had `dec()` coerced with `String(value)`, every page
would have rendered a plausible, silently corrupted figure and the defect would
have survived indefinitely — there is no visual difference between
`1501.5` and a double that has lost its last digits.

**Fix, in two parts.**

1. `v_current_rates` emits `partner_bid`, `partner_ask`, `min_size` and
   `max_size` as `text`. Column names and the exposed set are unchanged from
   §11.8; only the wire type changes. A new `v_rate_history` does the same for
   the history page, which needs the superseded and withdrawn rows the current
   view excludes by definition.
2. `dec()` **throws** on a non-string, naming §12.7 and the required `::text`
   cast. Failing loudly is the only behaviour that keeps D13 true; a defensive
   coercion would have hidden exactly this bug.

**Generalisation worth adopting:** §12.7 rule 1 is written about RPCs, but the
rule is about the *boundary*. Any view or table read directly by PostgREST is
the same boundary and needs the same treatment.

---

## F16 — Accessibility: two real defects, and one rule axe could not run

**Severity: medium. Status: CLOSED.**

§16.2 requires WCAG 2.1 AA, contrast checked in both themes, and *"an automated
axe scan plus one keyboard-only pass per page"*. Both halves are now scripted:
`npm run a11y`.

**What axe cannot do here, stated rather than glossed.** The scan runs in jsdom,
which has no layout and no cascade, so the `color-contrast` rule **cannot
execute**. Reporting a pass on a rule that never ran would be worse than not
running it, so the rule is explicitly disabled in the scan and contrast is
checked separately and deterministically by `scripts/contrast-check.mjs`
against the palette tokens, in light and dark.

**Defect 1 — control boundaries below 3:1.** `--border` was used both for
decorative table rules and for the visible edge of inputs, selects and buttons.
It measured **1.41:1** (light) and **1.57:1** (dark), against the 3:1 that
WCAG 2.1 SC 1.4.11 requires for *user interface components*. A decorative rule
is exempt; a control's boundary is not. Split into a separate
`--control-border` token at 4.83:1 and 6.14:1, applied to 29 control elements.

The blunt fix — darkening `--border` everywhere — would have passed the checker
while making every table heavier to read, and would have conflated two things
the standard treats differently.

**Defect 2 — a focus indicator removed.** The board's amount field is a
borderless input inside a bordered wrapper, so the currency suffix sits flush.
It carried `outline-none`, which removed its focus ring entirely: a keyboard
user tabbing to it saw nothing (WCAG 2.4.7). Fixed by moving the indicator to
the wrapper with `:focus-within` — 2.4.7 requires the indicator to be *visible*,
not to sit on any particular element.

**Result:** 12 routes, 0 violations, 214 checks passed; every rendered colour
pair AA in both themes. The static keyboard checks are clean too — no positive
`tabIndex`, no `onClick` on a non-interactive element, and the grid's add-row
and remove-row are real `<button>`s, as §16.2 requires.

**Still owed by a human:** an actual tab-through of each page. The static checks
prove nothing is structurally unreachable; they cannot prove the resulting
order is sensible.

---

## F17 — Missing configuration took down every route at once

**Severity: high. Status: CLOSED.**

The first Vercel deployment built successfully and then returned
`MIDDLEWARE_INVOCATION_FAILED` — a bare 500 with no detail — on **every** path,
including `/login`. The cause:

```
Error: Your project's URL and Key are required to create a Supabase client!
  route=/middleware  count=3  users=2
```

The environment variables were unset, so `createServerClient` threw inside
middleware. Middleware runs on every route, so a single throw there is a
total outage rather than a degraded page.

Missing configuration *is* a real failure and must not be papered over — but
the failure has to land somewhere that can explain it. Middleware now checks
for the variables, and when they are absent it skips the session refresh,
still applies the CSP and security headers, and redirects to `/misconfigured`,
which names exactly which variables are missing and prints no values
(`SUPABASE_SERVICE_ROLE_KEY` is reported only as present or absent, per §12.3).

Verified by running a production build with the variables emptied:

```
/login          307 -> /misconfigured
/board          307 -> /misconfigured
/misconfigured  200, names the missing vars, leaks no values, CSP present
```

The same path now covers a rotated or mistyped key, not just a first deploy.

---

## N3 — Vercel deployment protection: correcting an earlier claim

**Status: NOTED — the earlier assessment in this session was wrong.**

It was stated during the build that deployment protection is unavailable on
Vercel's hobby plan, and therefore that the internal-only app (D1) would be
publicly reachable. **That is incorrect.** The project reports:

```
ssoProtection: enabled, deploymentType "all_except_custom_domains"
passwordProtection: disabled
trustedIps: disabled
```

Vercel Authentication is on and covers every `*.vercel.app` URL, production and
preview, so the deployment is not publicly reachable today. It is *password*
protection that is the paid feature, not SSO protection.

Two consequences worth keeping in view:

- **A custom domain would not be protected.** `all_except_custom_domains` means
  attaching `ratehub.metacomp...` removes the Vercel Authentication gate for
  that hostname. At that point the only control is the application's own
  magic-link sign-in plus RLS — which is the designed boundary (§5: "the
  database is the boundary"), and T21 shows `anon` reads nothing. But the
  change in posture should be a deliberate decision, not a side effect of
  adding a domain.
- **Vercel Authentication gates humans, not correctness.** It is not a
  substitute for anything in §12; it sits in front of it.

---

## F18 — Self-signup is enabled, contradicting the invite-only model

**Severity: medium. Status: OPEN — needs a dashboard change.**

`auth.signUp()` from an anonymous client is accepted by the platform. The probe
was stopped only by an email rate limit, not by policy — meaning **anyone with
the publishable key can create an `auth.users` row**.

That contradicts the access model. D15: *"Backbone owns all access management"*,
and §13.2 makes `invite_partner_user` and `invite_staff` the only paths that
create a principal. Self-signup does not create a principal, so a self-registered
account is inert — `app.principal_id()` returns null, `currentPrincipal()`
returns null, and RLS denies everything (T21 covers exactly this shape). The
database boundary holds.

But three things are still wrong with leaving it on:

1. It lets an outsider write rows into `auth.users` at will.
2. It turns the project into an **e-mail sending vector** — each attempt sends a
   confirmation to an address the attacker chooses.
3. It exhausts the shared e-mail quota that real sign-ins depend on (F19).

**Fix (dashboard, no code):** Authentication → Sign In / Providers → Email →
disable **Allow new users to sign up**. Sign-in continues to work; only
self-registration stops. Magic links for invited principals are unaffected,
because `sign_in_allowed` already gates those against `principals`.

Also noted by the advisor: *leaked password protection disabled*. That is moot
here — §19 mandates magic link and **no passwords anywhere** — but it is only
moot for as long as the email provider's password grant is never used. Probing
`signInWithPassword` returned "Invalid login credentials" rather than "logins
are disabled", so the password grant is live even though nothing in the
application uses it.

---

## F19 — The built-in e-mail service rate limit is a go-live blocker

**Severity: high. Status: OPEN — needs an SMTP provider.**

The immediate cause of "the login has issue" in this session: Supabase's
**built-in** e-mail service allows only a handful of messages per hour across
the whole project. Several sign-in attempts plus a few probes exhausted it, and
further requests returned `email rate limit exceeded`.

The failure is close to invisible from the application's side. §19 and TM12
require the sign-in response to be **byte-identical** whether or not the address
is known, so `requestMagicLink` deliberately swallows the outcome and always
reports "if that address has access, a link is on its way". When the quota is
gone, the user sees exactly that message and no e-mail ever arrives.

That is correct behaviour for enumeration resistance and terrible behaviour for
diagnosis, and the two cannot both be satisfied in the response body.

**Consequence at go-live.** §2's test of success is a partner posting rates
daily and an RM answering without asking backbone. Both begin with a sign-in
e-mail. On the built-in service, a handful of people signing in within the same
hour silently locks out everyone after them.

**Fix:** configure a real SMTP provider (Authentication → Emails → SMTP
Settings) before any partner is onboarded. This is infrastructure the spec does
not mention and that no test in this repository can catch.

**Also worth doing:** send delivery failures to the error tracker server-side,
so the operator can see what the user must not be told. That is the same
shape as F10 — a signal that must not appear in the response body still needs
somewhere to go.
