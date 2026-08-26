-- =====================================================================
-- 0011  Deterministic audit ordering
-- Spec §11.7, §16.3. See docs/spec-findings.md F7.
--
-- occurred_at defaults to now(), which is TRANSACTION START time, not
-- statement time. §13 requires every RPC to write its audit event in the same
-- transaction as its effect, so events sharing a timestamp is the normal case.
--
-- Observed: partner.create, partner.set_policy and partner.confirm_convention
-- written in one transaction came back ordered confirm, set_policy, create --
-- arbitrary, because §11.7's index is on (occurred_at desc) alone and the sort
-- had nothing to break the tie with.
--
-- id is bigserial and monotonic, so it is the tiebreaker. Every read of
-- audit_events MUST order by (occurred_at desc, id desc).
--
-- occurred_at is left as specified. Moving it to clock_timestamp() would make
-- an event's stamp disagree with the transaction it belongs to, which is a
-- worse trade than requiring a two-column sort.
-- =====================================================================

create index if not exists audit_events_occurred_id
  on public.audit_events (occurred_at desc, id desc);

create index if not exists audit_events_partner_occurred_id
  on public.audit_events (partner_id, occurred_at desc, id desc);

comment on column public.audit_events.occurred_at is
  'Transaction start time. Events in one transaction share it; order by (occurred_at desc, id desc).';
