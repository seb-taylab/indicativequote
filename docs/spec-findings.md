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

**Severity: high. Status: OPEN — needs a decision.**

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
