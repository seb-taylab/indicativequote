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

**Severity: medium. Status: CLOSED — option 2 implemented in 0025.**
A separate `submission_failures` table, written by a distinct transaction after
the failed submission has rolled back. §6.4's atomicity is untouched and
asserted by test. See the resolution note at the end of this document.

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

---

## F20 — Two schema changes reached the database with no migration file

**Severity: high. Status: CLOSED — files reconstructed, guard test added.**

§18.1: *"Migrations are files in version control, applied in order, never
hand-edited in a dashboard. A schema change that reaches production without a
migration file is an incident, not a shortcut."*

Two had. Found by comparing `app.schema_migrations` against
`supabase/migrations/`:

| Applied to the database | File |
|---|---|
| `app.fmt_num` + the `board_rates` rewrite with readable reasons | missing |
| `v_rate_history` + `v_current_rates` emitting `text` | missing |

**What a rebuild from files alone would have produced.** Not an outage — a
*working* application with a defect silently restored. `v_current_rates` would
return `numeric` again, PostgREST would serialise every rate as a JSON number,
and JavaScript would parse it as a binary double: F15 verbatim, on a fresh
staging environment or a DR restore, with nothing failing to announce it. The
withheld-reason formatting would have regressed too.

This is the exact shape §18.1 is warning about, and it is worth being blunt
that a green test suite did **not** catch it — every test ran against the
drifted database, where the changes were present. A suite passing against a
database that no file describes proves nothing about what a deployment would
contain.

**Fix.** Both files reconstructed from the live catalogue via
`pg_get_functiondef` and `pg_get_viewdef`, so they provably match what is
deployed rather than what anyone remembers writing
(`scripts/reconstruct-migrations.mjs`). Ledger reconciled: 23 files, 23
applied, exact match.

**Durable fix.** `tests/schema/invariants.test.ts` now asserts the two sets are
equal in both directions — an applied migration with no file, and a file never
applied, both fail. Fixing the instance without the guard would have left the
next direct `apply_migration` free to do it again, and the pressure to do that
is highest exactly when someone is moving fast.

---

## F21 — T10 and T16–T20 were never automated, and a test corrupted shared state

**Severity: medium. Status: CLOSED.**

Two separate problems, found together.

**1. Coverage was overstated.** T10, T16, T17, T18, T19 and T20 were verified
during the build by impersonating roles in SQL and were never added to the
suite. §20.2 is explicit that the matrix must be *"automated, through the real
client with real sessions — never a manual check, never a service-role query"*,
and §21.2 requires T1–T26 to pass that way.

Counting `it()` blocks made this easy to miss: `matrix.test.ts` reported 23
passing tests, which reads like T1–T23 but is not. A check done once by hand
proves the code was right that afternoon; only a test proves it is still right,
and TM4/TM5 are precisely the guarantees a refactor reopens quietly.

Now in `tests/access/rpc-authorisation.test.ts` — 19 assertions through real
sessions. Suite: **96 tests across 4 files.**

**2. A test destroyed seed data.** `markup_one_active` permits one active
markup version per currency pair. The new tests created versions on the shared
USD/NGN pair, which **retired the seed's**, and teardown then deleted the
replacement — leaving the pair with no active markup at all. The board silently
stopped ranking anything for USD/NGN, and the seed world was broken for
everyone afterwards.

Nothing failed. The tests passed while quietly removing the state the
demonstration environment depends on.

**Fix.** The fixture now provisions a dedicated `USD/ZAR` pair, and every test
that mutates pair-level state uses it. Seed markup restored.

**The teardown lesson, worth generalising.** Three consecutive foreign-key
failures came from clearing references to test principals one at a time —
`markup_versions.retired_by`, then `audit_events.actor_id` (staff actions write
audit rows with `partner_id` NULL, so a partner-scoped delete misses them).
Teardown now enumerates every FK pointing at `principals` explicitly, in
dependency order, rather than discovering them one failure at a time.

**Standing rule:** a test that writes to shared reference data — a canonical
pair, a currency, a markup version — must own its own row, not borrow the
seed's. Constraints that permit exactly one active thing per key make borrowing
destructive rather than merely untidy.

---

## F22 — §12.7's fourth guarantee was never built

**Severity: medium. Status: CLOSED.**

D13's contract has four parts and only three existed. §12.7 rule 4:

> "A lint rule fails the build on `Number(`, `parseFloat(` or `+` applied to
> any value from a rate payload."

§21.2 lists it as an acceptance criterion — *"No rate value reaches JavaScript
arithmetic as a primitive — lint rule active and passing"* — and the build ran
only `assert-no-service-key`. The other three parts were sound, which is
exactly what makes the gap dangerous: NUMERIC in the database, text on the
wire, decimal.js in the application, and one `Number(row.partner_bid)`
anywhere undoes all of it. Silently, with no float in the schema, and no
visible difference in the rendered figure. F15 was that failure arriving by a
different route.

**The hard part was not finding `Number(` — it was not crying wolf.**

The first version reported six violations, every one of them English:
`Bid/ask convention` in a JSX heading parses as division, and
`* §16.3 /admin/markup` is a block-comment continuation line. A rule that
reports six false positives on its first run is suppressed within a week, and
then §12.7's fourth guarantee is gone while still appearing to be enforced.

§12.7 also governs **decimals, not integers**.
`Number(fd.get('soft_ttl_minutes'))` is correct code — TTL minutes are
`integer` in the schema. Flagging it would have taught everyone to ignore the
rule.

So the rule is name-directed: it flags coercion and arithmetic only where an
operand is decimal-bearing, keeps an explicit `INTEGER_FIELDS` allowlist so
that adding a decimal to it is a visible act, and takes a reasoned
`// decimal-safe: <reason>` opt-out rather than a blanket suppression.

**It carries a self-test.** A rule that cannot fail is not a rule, so it
asserts it still catches four known-bad shapes before trusting a clean report,
and refuses to pass if it has been broken. Verified end to end: a planted
`Number(row.partner_bid) * 2` exits 1 and fails the build; removing it exits 0.

Wired into `npm run build` alongside the service-key check, and available as
`npm run lint:decimals`.
---

## F23 — The retention job existed but nothing ever ran it

**Severity: high (privacy). Status: CLOSED.**

Migration 0020 created `app.purge_raw_input()` and **nothing called it**. §21.2
lists *"raw_input older than 90 days is nulled and stamped"* as an acceptance
criterion, and it was simply false — the function existed, the retention did
not happen. A control that is never executed is a belief, not a control, which
is the same point §18.3 makes about a backup nobody has restored.

This is a **privacy** obligation rather than housekeeping. §18.4: `raw_input`
is the partner's exact pasted text, *"which may carry greetings, names or
unrelated content"*. Retaining it indefinitely because a job was never
scheduled is the kind of gap found by a data-protection review, not by a test
suite — every test passed throughout.

**Fix.**
- `pg_cron` installed; `purge-raw-input` scheduled daily at 03:17 (an off-hour
  minute, so it does not pile onto :00 with everything else).
- `app.run_raw_input_purge()` wraps the purge and records every run — including
  a failure — in a new `app.job_runs` table. A job that fails silently and a
  job that never ran look identical from outside, and §18.2 has to tell them
  apart.
- `job_health()` exposes the heartbeat to operators, and `/admin/health` now
  shows it: on schedule or **overdue**, when it last ran, whether it failed,
  how many submissions still hold raw text.

§18.2's *"Purge job did not run in 25 hours → alert"* previously had no source
to read. `app.job_runs` is that source, and `overdue` is that condition
computed rather than left to be inferred from a timestamp.

**Verified by execution**, not by scheduling and hoping:

| Submission | raw_input | purge stamp |
|---|---|---|
| 120 days old | nulled | stamped |
| 3 days old | untouched | none |

The stamp matters on its own: it distinguishes *"we deleted this"* from
*"there never was any"*, which is the difference between a retention record and
a gap.

---

## N4 — The repository lives in a OneDrive-synced folder, and it is causing real damage

**Severity: high (to the work, not the product). Status: OPEN — needs a move.**

Not a defect in the Rate Hub. Recorded because it has now caused four distinct
failures in this project, each of which cost time and one of which nearly lost
work:

| Symptom | Cause |
|---|---|
| `next dev` dies with `EINVAL: readlink .next/diagnostics/framework.json` | sync touching build output |
| `next build` dies with `EBUSY: open .next/diagnostics/build-diagnostics.json` | same, mid-write |
| **Local git history reduced to a single orphan commit** | `.git` clobbered by sync |
| `docs/spec-findings-CTX-164.md` appearing as a duplicate | sync conflict copy |

The git one is the serious one. `HEAD` became a lone commit with no ancestors
while the remote held 20 — so a `git push --force` at that moment, which is the
reflex when a push is rejected, would have destroyed the entire project history.
It was recoverable only because the remote was ahead and the push was *rejected*.

The conflict copy is the subtle one: the F23 append landed in
`spec-findings-CTX-164.md` while `spec-findings.md` silently reverted to its
previous state. Both files existed, both looked plausible, and the canonical one
was the wrong one. Promoted the complete copy and added a `.gitignore` rule so a
future conflict file cannot be committed.

**Recommendation: move the working copy out of the synced folder** — e.g.
`C:\dev\indicativequote`. Git is already the sync mechanism; OneDrive on top of
it provides nothing and actively corrupts `.git` and build output.

**Until then:** never `git push --force` from this checkout without first
confirming `git rev-list --count HEAD` looks sane against the remote, and treat
a rejected push as evidence of local corruption rather than of a stale branch.

---

## N5 — The eligibility gates now have tests, and the schema caught the fixtures

**Severity: none. Status: NOTED.**

§14's nine gates decide which rates an RM may price against, and §20.3 rates
them Critical/High, but they had only ever been exercised incidentally — a
couple of gates observed in passing while testing something else. 17 tests now
cover each gate individually, plus the ordering and the `record_quote_copy`
re-check.

Two properties are asserted separately for every gate, because they are
separate claims:

- **E1–E5 are not rendered at all.** An inactive partner, an unconfirmed
  convention, a deactivated pair, a withdrawn row or a superseded row must not
  appear *even below the divider*.
- **E6–E9 are rendered, below the divider, with their reason** — §7: *"an RM
  needs to know a rate exists but cannot be used, and why"*, and *"withheld
  rows are counted and named, never silently dropped"*.

The ordering is tested directly, because it is what a re-implementation gets
wrong: a row that is both inactive and expired reports **E1** and vanishes,
rather than appearing as "expired"; unconfirmed-convention beats no-markup;
expired beats out-of-band.

**The schema caught the test fixtures, twice.** Seven tests failed initially,
every one because the fixture SQL violated a constraint rather than because the
gate was wrong:

- `validity_order` (`valid_from <= expiry_warning_at <= valid_until`) rejected
  an "expire this rate" update that moved only `valid_until` into the past.
- `retired_shape` rejected a markup retirement that set `retired_at` without
  `retired_by`.

Both fixtures now go through the real path — all three stamps move together,
and markup is retired via `retire_markup_version`. Worth recording because the
constraints were doing exactly the job §11 designed them for, against the test
code rather than the application, and a fixture that bypassed them with looser
SQL would have tested a state the application can never produce.

---

## F24 — The parser silently discarded a minus sign

**Severity: high. Status: CLOSED.**

Found by writing §20.3's *"transposed, malformed and hostile input"* tests,
which had never been done.

`USD/NGN -1392 | 1394` parsed as **a bid of 1392**. The `NUMBER` pattern
matches digits only, so the sign was never captured — it was simply left behind
as a stray character and dropped. The partner's value changed meaning between
what they sent and what the grid offered, and they were told nothing.

The database could not catch it either: `positive_rates` checks `bid > 0`, and
by the time the value reached the RPC the sign was already gone. Every layer
below the parser saw a perfectly valid positive rate.

This is exactly the guess §6.5 forbids. §6.3 error 3 sets the standard — three
or more numbers on a line is *"reported, never guessed"* — and dropping a
character that inverts a value's meaning is a far larger guess than picking two
numbers from three.

**Fix.** A hyphen is also a legitimate separator (`usd/ghs 11.77-11.81`, an
observed variant in §6.5), so the two are distinguished by what precedes it: a
hyphen following a digit separates two rates; one that does not, and is
followed by a digit, is a sign, and the line is rejected with
*"A rate cannot be negative."* The separator case is asserted alongside it, so
the fix cannot silently break the variant it had to preserve.

**A second, smaller one.** `USD/NGN 0 | 1394` parsed cleanly and was offered as
submittable, only for `positive_rates` to refuse it at `submit_rates`. §16.1 is
clear that a failed submission must not be where a partner discovers a problem,
so a zero on either side is now rejected in the parser, in the partner's own
words.

**On the tests that found it.** The first version of these assertions was
written as `if (row) { ... } else { ... }` — passing whichever way the parser
behaved. All 36 passed on the first run and proved nothing about either case. I
probed the actual behaviour before tightening them, which is what surfaced both
defects. **A conditional assertion is not a test**; it is a description of
whatever the code already does.

Also verified, since the parser handles untrusted external text: no input
throws (empty, emoji, RTL, zero-width, CRLF, lone separators); every non-empty
line is accounted for as parsed, rejected or ignored; rejected lines come back
verbatim; SQL- and script-shaped text is returned as text and never
interpreted; and the pattern does not backtrack pathologically — a
10,000-character line, 3,000 repeated near-matches and a 2,000-line block all
complete in under a second.

---

## F10 resolved — how "recent failures" was made possible

**Implemented in migration 0025. Closes the OPEN item above.**

§9 wants failed submissions on the health page; §18.2 alerts on *"more than 2
for one partner in an hour"*; and §2 explains the stake — *"a partner hitting
errors silently stops using the product"* is named as the risk that decides the
outcome. But §6.4 makes a submission atomic, so a batch failing validation
raises and is discarded whole, envelope included. `error_count` could only ever
be `0`.

The two requirements cannot both be met inside one transaction, and the wrong
resolution would have been to write the envelope outside §6.4's guarantee —
atomicity is what makes *"either every confirmed row is stored or none is"*
true, and it is worth more than the telemetry.

**What was built.** `public.submission_failures`, written by
`record_submission_failure()` — a **second, separate call** the route makes
after `submit_rates` has already raised and rolled back. A distinct
transaction, so it survives. §6.4 is untouched, and a test asserts that a
failed batch still writes no rate and no envelope.

**Deliberately not stored: `raw_input` and rate values.** §18.2 forbids them in
logs, and duplicating a partner's pasted text here would put the same personal
data outside §18.4's 90-day purge, in a table nobody would think to sweep. The
reason and the row count are what §9 asks for and are enough to act on. A test
asserts those columns do not exist.

**Best-effort by design.** If the log write fails, the partner still sees their
error. Telemetry must never mask the thing it was recording.

Visibility follows `rate_submissions`' shape (§12.6): a partner sees its own,
operators and admins see all, `rm_viewer` sees none — an RM prices tickets and
does not need to know which partners are struggling. No role can write
directly; the RPC is the only path (D2). All asserted.

**The guard tests earned their place here.** Adding the table broke two of them
immediately — the RLS invariant that every business table is accounted for, and
the migration-drift guard, which caught 0025 before it had been recorded in the
ledger. Neither failure was a bug; both were the guards doing exactly what F20
and F21 added them for.

---

## F25 — "expired, valid until HH:MM SGT" is ambiguous across a date boundary

**Severity: medium. Status: CLOSED.**

§14 specifies E7's reason as *"expired, valid until HH:MM SGT"* — a bare time,
no date. SGT is UTC+8, and a partner who stops submitting leaves rates that
expired on an earlier day, so the bare time can read as a moment **still ahead
of the reader**.

Caught while writing §20.3's timezone tests, and then confirmed by the clock
rolling over during the work:

```
now                          27 Aug 08:33 SGT
rate actually expired at     26 Aug 23:35 SGT
E7 reported                  "expired, valid until 23:35 SGT"
```

An RM reading that at 08:33 sees an expiry fifteen hours in the future, on a
row the board is simultaneously calling expired. §7's whole purpose is that the
RM answers the question without asking anyone; a self-contradicting row sends
them straight back to backbone.

**Fix.** The spec's format is kept for the common case — the default TTL is 8
hours, so most expiries are same-day — and the date is added only when the
expiry falls on a different SGT date to now. §14 is honoured where it is
unambiguous and repaired where it is not. Both forms are asserted, so the
same-day case cannot silently acquire a date either.

Verified live on the seeded rates after midnight:
`"expired, valid until 26 Aug 23:35 SGT"`.

**The rest of A-3 was already correct.** UTC storage with SGT display handles
the day, month and year boundaries correctly, has no daylight-saving
discontinuity, and never falls back to the machine's local zone — 10 tests now
pin that, including the year rollover (`31 Dec 16:30 UTC` → `01 Jan 2027`).

Two of those tests failed first time on **my expectations, not the code**:
en-GB abbreviates September as "Sept", not "Sep", and `age()` rounds so 30
seconds already reads as a minute. Both assertions were corrected to what the
code actually does, because the dates were right and that was the claim under
test.

---

## N6 — The migration runner had the same `.env.local` defect as the tests

**Severity: low. Status: CLOSED.**

`scripts/apply-migrations.mjs` used `import 'dotenv/config'`, which reads `.env`
only — so it reported *"DATABASE_URL is not set. Copy .env.example to
.env.local and fill it in"* while `.env.local` sat there fully populated. The
advice in the error was the very thing that had already been done.

The test helpers had the identical bug (fixed earlier); this was the second
instance and went unnoticed because every migration until now had been applied
through the Supabase MCP rather than the runner. Both now load `.env.local`
first, then `.env`, with real environment variables still winning for CI.

Worth noting the shape: a tool that is never exercised drifts out of working
order silently, and its first real use is the worst moment to discover it.

---

## N7 — Lifecycle: reactivation and correction idempotency now tested

**Severity: none. Status: NOTED. No defect found.**

§20.3 names four lifecycle operations at High priority — supersession,
correction, withdrawal, **reactivation** — and rates correction's idempotency
key separately. Supersession had golden test 4; reactivation and the
idempotency key had never been tested at all. 12 tests now cover them, and the
implementation was correct throughout.

The claims worth having pinned, each being a place a plausible implementation
would get it wrong by **recomputing something it should have read**:

- §13.2's *"reactivation does not resurrect expired rates, because validity is
  stamped"*. A rate that expires while its partner is deactivated stays expired
  when the partner returns. An implementation deriving validity on read — rather
  than honouring D5's stamps — would quietly bring it back to life.
- Deactivation is **not** withdrawal. A deactivated pair's rates remain stored
  and return intact on reactivation; a withdrawn row does not, because
  withdrawal is the partner's own decision and permanent for that row while
  deactivation is backbone's and reversible.
- §6.6's inherited expiry survives a **chain**. Correcting a correction still
  carries the original `valid_until`, so a partner cannot ratchet a quote's life
  forward one typo at a time.
- A retried `correct_rate` with the same key returns the original submission and
  writes no second row; the same key used by a *different* partner is not a
  collision, because `rate_submissions_idem` is unique per
  `(partner_id, idempotency_key)`.

**A test that would have passed while asserting nothing.** The
"refuses to correct a superseded row" case initially failed with
`'no such rate'` instead of `'superseded'` — because the helper **deleted** the
previous row before each submit, so the old id had vanished rather than been
superseded. Had the assertion been written loosely (`expect(error).not.toBeNull()`)
it would have passed, while testing that correcting a *non-existent* row fails
— which nothing in §6.6 is about. The helper now has a `submitOver()` sibling,
and the test asserts the old row is still present with `superseded_by` set
before attempting the correction.

That is the same failure mode as F24's conditional assertions: a green test
that describes the wrong situation.

---

## N8 — §16.1's degraded states are now asserted, and a note on skipping

**Severity: none. Status: NOTED. No defect found.**

§20.3 requires *"every row of 16.1 rendered and asserted"* and none of it had
been tested. 13 tests now cover the degraded states against the **server-
rendered HTML of the real application**, with real magic-link sessions — the
assertions are about what the server decides to say, which is where each of
these states is actually chosen.

Covered: the board's empty state naming which partners support the pair; no
active markup withholding every row, saying why, and linking to `/admin/markup`;
all-rows-ineligible showing them below the divider with reasons and a withheld
count; stale rows rendered rather than hidden, with the status word present
(§16.2: never colour alone); the disclaimer beneath the table; both submission
entry paths so D7's "no paste-only dead end" holds; session expiry redirecting
to `/login` with **no data cached in the URL**; and permission denied stating
plainly what is not allowed and offering a way back rather than a blank page.

§5's zone separation is asserted in both directions, which had not been tested
before: a partner reaching `/admin/markup` and a member of staff reaching
`/partner/submit` both land on `/denied`, not on a 500 or an empty page.

*"Best execution"* is asserted absent across five routes, as §7 demands.

**On the skip.** These need a dev server, so the suite would otherwise fail
whenever one is not running — which reads like a product defect and trains
people to ignore red. They now skip instead, but **loudly**: a 72-character
banner naming what was not covered and why a green run without them does not
satisfy §20.3.

A quietly skipping suite is worse than a failing one. §20 calls tests
"executable doctrine", and doctrine that silently does not run is not doctrine
— `13 passed` and `13 skipped` look identical at a glance in a scrolling log.
The skip path was verified by pointing the suite at a dead port, because a skip
mechanism that does not actually skip is just an untested branch.

`npm run test:degraded` runs them alone.

---

## N9 — The schema can be rebuilt from migrations alone. It had never been tried

§18.1 makes the migration files the schema: *"applied in order, never
hand-edited in a dashboard."* But every migration here had only ever been
applied **incrementally**, to one long-lived database, in the order I happened
to write them. The from-scratch path — the one a restore actually takes — had
never once been exercised. F20 had already shown what that costs: two schema
changes had reached the database with no migration file at all, so a rebuild
would silently have restored the F15 defect.

`scripts/verify-rebuild.mjs` now creates a scratch database, applies all 26
migrations in order, and fingerprint-compares seven categories of schema object
against live.

It passes: **12 tables, 161 columns, 80 constraints, 37 indexes, 24 policies,
41 functions, 2 views — identical.** §18.1's claim is now checked rather than
asserted, and §18.3's rehearsal has a mechanical half that a human timing a
restore no longer has to discover.

Two things fell out of building it.

**An undeclared platform dependency.** The migrations require the `auth` schema,
`auth.uid()` and an `extensions` schema to already exist. Supabase provisions
all three before any migration runs, so the dependency is invisible on Supabase
and fatal anywhere else. The script stubs them explicitly and says so, rather
than letting a green run imply the migrations are self-contained. This is
recorded in the runbook: a restore into a fresh *Supabase* project gets them
free; a restore into bare Postgres does not.

**A cleanup bug that left debris on a real project.** The first run finished the
comparison and then failed to drop the scratch database:
`55006 — database "ratehub_rebuild_check" is being accessed by other users`.
`client.end()` had already been called. The cause is that `DATABASE_URL` points
at Supabase's **pooler**: `end()` returns the connection to the pool rather than
closing the server-side session, so for a short window Postgres still sees a
session on the scratch database. Probing `pg_stat_activity` a minute later
showed zero sessions — the release is real but asynchronous.

A verification script that abandons a stray database on a production project
every run is worse than no verification script. Cleanup now terminates
remaining backends, uses `drop database ... with (force)`, and retries on 55006
with a backoff. Verified by a full clean run, comparison and drop included.

---

## F26 — §18.3 requires a restore runbook by name, and there was none

§18.3 ends with a sentence that is a deliverable, not advice: *"The restore
runbook names who does it, in what order, and how the application is pointed at
the restored project."* It did not exist. `docs/deploying.md` carried an
unticked checklist line and nothing behind it.

`docs/restore-runbook.md` now exists and answers all three parts.

The finding worth recording is not the missing document but something found
while writing it.

**A logical-dump restore would silently have undone the privilege lockdown.**
TM1 — a partner reading a competitor's rates — is defended by revoked grants
and RLS. Those revocations are ACL state. A dump taken with `--no-acl` or
`--no-owner`, which is the common default advice for moving a database between
Supabase projects, restores every table, policy and function *without* them. The
restored system looks correct, renders correctly, and passes a smoke test, while
`PUBLIC` access to partner rate data has been quietly reinstated. F1 already
established that this project cannot rely on default privileges behaving as
§12.2 assumes; a restore is exactly the moment that would resurface.

The runbook therefore mandates: **schema from migrations, data from the dump.**
That is only a safe instruction because N9 verified the schema half reproduces
live exactly — otherwise it trades one silent divergence for another.

Two supporting decisions:

- **The acceptance test for a restore is the access matrix, not the pages.**
  T1–T23 run with real magic-link sessions and never a service-role query, so
  they test what a restored board renders *to whom*. A board that renders proves
  nothing about who can read it. T26 specifically re-checks that no function is
  executable by `PUBLIC` — the exact property the ACL trap destroys.
- **What a backup does not contain is stated before the steps, not after.** Auth
  URL configuration, SMTP, self-signup and the JWT secret all reset. §19/TM12
  makes sign-in byte-identical whether the email is unknown or the redirect
  allowlist is wrong, so a misconfigured restore presents as a silent,
  undiagnosable login failure — which has already cost this project one
  debugging session.

The runbook is honest about what remains a belief: no nightly logical dump
exists yet, PITR retention is unconfirmed, and no full restore has ever been
performed. The schema half is proven; the data half, the dashboard
reconfiguration and the timing need a human with the clock running, before
go-live.

---

## N4 addendum — OneDrive made a new file invisible to `git status`

Recorded 2026-08-27, immediately after it happened, because it is the first
time the OneDrive problem has been capable of *silent* damage rather than
merely noisy failure.

`scripts/verify-rebuild.mjs` was written, patched, and run successfully. Minutes
later, with no intervening command touching it:

- `ls -la scripts/` did not list it
- `find . -name "*verify-rebuild*"` found nothing
- **`git status --short` did not report it as untracked**

The file had not been deleted. OneDrive had dehydrated it — replaced the local
copy with a cloud placeholder — and every tool that walks the directory
reported it as absent. About two minutes later it reappeared intact, with its
original size and modification time.

**Why this is worse than the failures already recorded under N4.** The earlier
symptoms were loud: `EINVAL` on `readlink .next`, `EBUSY` on build artefacts, a
sync-conflict file, and the clobbered `.git` directory that produced the orphan
commit. Each of those stopped a command and demanded attention. This one does
not. A `git add -A && git commit` issued during that window would have
succeeded, reported success, and silently omitted the file — producing a commit
that looks complete and is not.

That is precisely the F20 failure mode, reproduced by the filesystem instead of
by carelessness: work that exists in the running system but not in version
control, discovered later, when a rebuild produces something other than what
was tested.

**Mitigation applied now:** new files are staged as soon as they are written
rather than at the end of a work item, and `git status` output is checked
against `git ls-files` when a file that should be untracked does not appear.
The commit for this work item was verified to contain `scripts/verify-rebuild.mjs`
before pushing.

**The real fix remains the one N4 already recommends:** move the checkout out of
the OneDrive-synced folder. This is now the fourth distinct class of damage from
the same cause, and the first that can corrupt a commit without any error being
shown.

---

## F27 — There was no CI, and the first dependency scan found seven advisories

§18.5's transport row ends with **"dependency scanning in CI"**. §20 opens by
calling the tests "executable doctrine". Neither statement was true: there was
no `.github/` directory. Every check in this project — 207 tests, the schema
drift guard, the two build guards, the accessibility scan — had only ever run
on one laptop, by hand, when someone remembered to run it.

`.github/workflows/ci.yml` now exists. What it found on its first run is the
argument for why it should have existed from the start.

### Seven advisories, one critical

`npm audit` had never been run against this tree. It reported **7
vulnerabilities: 1 critical, 2 high, 4 moderate.**

All seven were in development and build tooling rather than in anything served
to a browser, and none was exploitable as configured — the critical
(GHSA-5xrq-8626-4rwp) requires the Vitest UI server to be listening, which this
project never starts. That is the correct assessment, and it is also exactly
the assessment nobody was in a position to make, because nothing was looking.

`npm audit fix --force` proposed `next@16.3.3` and `vitest@4.1.11`, two major
bumps. Both were avoidable:

- **postcss** (2 high, 1 moderate) was already present at a patched 8.5.26; the
  vulnerable 8.4.31 was a stale nested copy under `next`. An `overrides` entry
  pinning `postcss` to `^8.5.26` resolved all three **without touching Next's
  major version**.
- **vitest** and its `vite`/`esbuild` chain (1 critical, 1 high, 3 moderate)
  needed 2.x → 3.2.7 — one major, not the two npm suggested. The suite uses
  nothing exotic (`describe`, `it`, `expect`, `beforeAll`, `describe.runIf`,
  and `fileParallelism: false`), so the risk was low and, more to the point,
  measurable: **all 207 tests pass on vitest 3.**

Result: **0 vulnerabilities**, with `next` still on 15.

### `npm run lint` had never linted anything

Wiring the existing `lint` script into CI surfaced a second problem. There was
no ESLint dependency, no `eslint.config.*`, no `.eslintrc`. The script ran
`next lint`, which in Next 15.5 is deprecated and responds by opening an
**interactive codemod prompt**. On a laptop that is a confusing menu; in CI it
is a hung job.

So the lint script was scaffolding that had never run, and it was about to be
made load-bearing. ESLint 9 with `next/core-web-vitals` and `next/typescript`
is now configured, and `npm run lint` is `eslint . --max-warnings=0`.

The codebase came back almost clean: one error and two warnings across the
whole tree, all three fixed. The error was an unused `Decimal` import in
`tests/unit/parser-hostile.test.ts` — harmless in itself, but the same shape as
F24, where a value was computed and then never actually asserted on.

Two rules are set beyond the Next defaults, each for a reason this project has
already paid for:

- `@typescript-eslint/no-unused-vars` as an **error** — F24's conditional
  assertions were a result computed and not checked.
- `@typescript-eslint/no-explicit-any` as an **error** — §12.7/TM16 route every
  decimal across every boundary as text, and
  `scripts/assert-no-float-arithmetic.mjs` is name-directed, so it cannot see a
  NUMERIC that has become a double by way of `any`.

### How the workflow is split, and why it announces its own gaps

§20.2 requires the access tests to run "with a real session, never a
service-role query", so they need a real Supabase project. That forces a split:

- **No credentials** — typecheck, lint, unit tests, `npm audit` (failing on
  high and critical), and a build. The build is not there for the artefact; it
  is there because `npm run build` is what runs the guards §12.3 and §12.7
  require to fail a build. Verified: it builds green with placeholder env, as
  every route is server-rendered on demand and nothing contacts Supabase at
  build time.
- **Credentials required** — the access matrix, RPC authorisation, the golden
  tests, schema invariants, the degraded states (with the dev server started so
  they do not skip), and the §18.1 rebuild check.

The second group cannot run on a fork's pull request. N8's rule applies
directly: a suite that silently does not run is worse than one that fails,
because green looks identical either way. When the project secrets are absent
the workflow emits a step annotation and a run summary naming exactly what was
not exercised — T1–T23, the golden tests, T24–T26, §16.1 — and stating that a
green tick means the types, lint, unit tests, build guards and dependency scan
passed and nothing about who can read whose rates.

Runs against the shared project are serialised with a concurrency group. F21
was a test corrupting shared state, and the documentation is explicit that
these secrets should point at a **staging** project, not production —
serialising damage is not preventing it.

### A smaller thing, fixed while here

There was no `.gitattributes`. The workflow contains shell scripts that run on
Ubuntu, and a Windows checkout with `core.autocrlf=true` gives them CRLF
endings, which bash rejects with `$'\r': command not found`. `*.yml`, `*.yaml`,
`*.sh` and `*.sql` are now pinned to LF. The SQL entry is not cosmetic: §18.1
makes those files the schema, and their diffs should be honest across
platforms.
