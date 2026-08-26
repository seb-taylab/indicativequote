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
| 1 | Schema and access control | **built** — T24–T26 green; T1–T23 written, awaiting credentials to run |
| 2 | Registry and partner administration | not started |
| 3 | Identity and invitations | not started |
| 4 | Submission — `submit_rates`, parser, grid, bands, supersession | not started |
| 5 | Board — `board_rates`, eligibility, ranking, markup, `record_quote_copy` | not started |
| 6 | Correction, withdrawal, history | not started |
| 7 | Health and audit pages | not started |
| 8 | Degraded states, accessibility, seed data, restore rehearsal | not started |

Step 1 ships *"with T1 to T26 green and no application at all. If the foundation
is wrong, everything above it is wrong, and this is the cheapest point to find
out."* Three defects were found doing exactly that — see
[docs/spec-findings.md](docs/spec-findings.md).

## Running it

```bash
npm install
cp .env.example .env.local   # then fill in the two secrets
npm test
```

`.env.local` needs `SUPABASE_SERVICE_ROLE_KEY` and `DATABASE_URL`, both from the
Supabase dashboard. Neither is committed; `.gitignore` covers `.env*`.

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
