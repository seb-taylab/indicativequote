# MetaComp FX Rate Hub

Internal rate board with an indicative quote. Partners post their own FX rates;
RMs read them without asking backbone. Built to `rate-hub-spec-v2-1`.

**Not** a pricing engine, a router, or an execution or settlement system.

---

## Where the build has got to

Following the spec's own sequence, §21.1. Each step ends with something
demonstrable, and nothing proceeds while the previous step's tests are red.

| # | Step | State |
|---|---|---|
| 1 | Schema and access control | **done** — T1–T26 green through real sessions |
| 2 | Registry and partner administration | **built** |
| 3 | Identity and invitations | **built** — T16–T19 verified |
| 4 | Submission — `submit_rates`, parser, grid, bands, supersession | **done** — grid verified in a browser |
| 5 | Board — `board_rates`, eligibility, ranking, markup, `record_quote_copy` | **done** — verified in a browser |
| 6 | Correction, withdrawal, history | **done** |
| 7 | Health and audit pages | **done** — per partner-pair |
| 8 | Degraded states, accessibility, seed data, restore rehearsal | seed, degraded states and the a11y pass done; schema rebuild verified (`scripts/verify-rebuild.mjs`) and the runbook written ([docs/restore-runbook.md](docs/restore-runbook.md)); **full restore rehearsal outstanding** |

Step 1 ships *"with T1 to T26 green and no application at all. If the foundation
is wrong, everything above it is wrong, and this is the cheapest point to find
out."* Three defects were found doing exactly that — see
[docs/spec-findings.md](docs/spec-findings.md).

## Test suite

224 tests across 12 files. `npm test` runs all of them; `npm run a11y` is
separate. CI runs the credential-free half on every push and pull request,
and the rest only where a real project is available -- see
[docs/deploying.md](docs/deploying.md).

| File | Covers |
|---|---|
| `tests/unit/domain.test.ts` | Golden 1 and 3, parser, markup, ranking, precision |
| `tests/unit/parser-hostile.test.ts` | The parser against deliberately hostile input |
| `tests/unit/timezone.test.ts` | A-3 — UTC storage, SGT display, across a date boundary |
| `tests/schema/invariants.test.ts` | T24–T26, RLS/policy/view invariants, migration-drift guard |
| `tests/access/matrix.test.ts` | T1–T9, T11–T15, T21–T23, Golden 2 |
| `tests/access/rpc-authorisation.test.ts` | T10, T16–T20 — RPC authorisation through real sessions |
| `tests/access/submission-failures.test.ts` | §6.4 atomicity holds while the attempt is still recorded |
| `tests/access/monitoring.test.ts` | §18.2 signals and their thresholds, both sides of each boundary |
| `tests/golden/supersession.test.ts` | Golden 4 — supersession, renewal, six-way concurrency, D5 |
| `tests/golden/eligibility.test.ts` | E1–E9, the eligibility gates |
| `tests/golden/lifecycle.test.ts` | Reactivation and correction idempotency |
| `tests/degraded/states.test.ts` | §16.1, every degraded state, server-rendered |

Golden tests 1 to 4 all present. T1–T26 all covered.

## Running it

```bash
npm install
cp .env.example .env.local   # then fill it in
npm run dev                  # http://localhost:3000
npm test
```

`.env.local` needs the two Supabase public values plus
`SUPABASE_SERVICE_ROLE_KEY` and `DATABASE_URL`. Nothing is committed;
`.gitignore` covers `.env*`.

Deploying: see [docs/deploying.md](docs/deploying.md).

The service-role key is used only by the test harness to build fixtures and by
server-side routes. §12.3: it MUST NOT appear in any browser bundle, and
`scripts/assert-no-service-key.mjs` fails the build if it does.

## Layout

```
supabase/migrations/   ordered, versioned, never hand-edited in a dashboard (§18.1)
tests/schema/          T24-T26 -- assertions against pg_catalog
tests/access/          T1-T23  -- the isolation matrix, through real sessions
tests/golden/          the four golden tests (§20.1)
docs/spec-findings.md  defects and open decisions found against the spec
```

## The parts that decide correctness

Read these before changing anything.

- **`[A-1]`, §1.4.** That `USD/NGN 1392 | 1394` means lower = the partner's bid
  is an *assumption*. If it is false every direction mapping inverts. It MUST be
  confirmed in writing per partner; `convention_confirmed_at` is the gate and a
  partner without it can never rank.
- **Direction → side, §10.2.** Lives in exactly one function and is never
  re-derived. `client_sells_base` uses `partner_bid`; `client_buys_base` uses
  `partner_ask`.
- **Markup widens the spread, §15.1.** Both sides move *away* from the partner
  price. A single directional addition makes half of all quotes wrong in the
  client's favour.
- **Decimals cross every boundary as strings, §12.7.** `NUMERIC` in the database,
  `decimal.js` in the application, never a JavaScript `Number`. PostgREST
  serialises `numeric` as a JSON number and JS parses it as a binary double, so
  precision is lost with no float anywhere in the schema.
- **Mutation is RPC-only, D2.** No table grants INSERT, UPDATE or DELETE to any
  application role, and no table has a non-SELECT policy. §13 is the complete
  write surface.
- **"Best execution" MUST NOT appear anywhere.** Permitted phrasing is
  "best eligible displayed rate".
