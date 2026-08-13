-- When did this person last write to us? — the 24-hour-window record.
--
-- Meta bills every TEMPLATE send. It does not bill free-form text sent inside
-- the 24 hours a recipient's own inbound message opens (the "customer service
-- window"). Until now the 07:00 briefing sent a paid template to EVERYBODY,
-- including people who had messaged Capo minutes earlier — issue #46, defect 1.
--
-- Deciding which envelope to use needs exactly one fact that this schema did
-- not record anywhere: the timestamp of the last inbound message from each
-- person. `messages` does not answer it (managers only, and worker text is
-- deliberately never written there — 0027), `worker_messages` does not answer
-- it (worker text only, and only for turns that reached the agent), and
-- notification_log is the OUTBOUND ledger. Hence one column, on each of the two
-- tables that can be a WhatsApp recipient.
--
-- ── nullable, no default, no backfill ──────────────────────────────────────
-- Same posture as 0025's consent columns and for the same reason: a manufactured
-- value would be a claim we cannot support. A null here means "no inbound on
-- record", which the send path reads as "not inside the window" and answers with
-- a template — the fail-closed direction. A free-form message sent OUTSIDE the
-- window is rejected by Meta with error 131047 and the person receives nothing
-- at all, and silence is the failure mode this product exists to avoid. Paying
-- for a template we did not strictly need is the cheap mistake; going quiet is
-- the expensive one.
--
-- Every row therefore starts on the template path and moves to the free-form
-- path the first time its owner writes to us, which is exactly the event that
-- opens the window in the first place. There is nothing to backfill: a
-- backfilled timestamp would assert a conversation that may have expired months
-- ago, and the only consequence of getting that wrong is a silent non-delivery.

-- ── the column ─────────────────────────────────────────────────────────────
-- Stamped by the WhatsApp webhook (apps/web/app/api/whatsapp/route.ts) on every
-- inbound message, on the SERVICE-ROLE client, as a separate best-effort write
-- that cannot cost anybody their reply if it fails — the same shape and the same
-- reasoning as captureBsuid beside it. A failed stamp costs at most one
-- wrongly-classified window (a template where free text would have done), never
-- a dropped message.
alter table workers add column last_inbound_at timestamptz;
alter table profiles add column last_inbound_at timestamptz;

-- ── who may write it: nobody but the service role ──────────────────────────
-- No grant is issued here, and that is the whole of the access-control story.
--
-- 0025 revoked the table-wide UPDATE on both tables and re-granted an explicit
-- COLUMN LIST to `authenticated`:
--   workers  → (name, trade, phone, active, language,
--               whatsapp_opt_in_at, whatsapp_opt_out_at)
--   profiles → (full_name, phone, language,
--               whatsapp_opt_in_at, whatsapp_opt_out_at)
-- Column grants are per-column and are NOT inherited by columns added later, so
-- a new column on a table whose UPDATE grant is column-scoped is unwritable by
-- the tenant from the moment it exists. Verified against 0025 rather than
-- assumed; if either grant is ever widened back to a bare `grant update on
-- table …`, this column silently becomes tenant-writable and a manager could
-- forge a 24-hour window for one of their own crew. That would cost a silent
-- non-delivery, not a tenant leak — but it would be silent, which is worse.
--
-- INSERT is a different question and does not matter here. A tenant can insert
-- a `workers` row (0028 column-scoped that grant to the seven editable columns
-- plus company_id, so last_inbound_at is excluded there too), and `profiles`
-- has no INSERT policy at all, so an INSERT is refused outright regardless of
-- grants. Either way the value can only ever start null.
--
-- SELECT is deliberately left alone: it is table-wide on both tables and the
-- send path reads the row with select('*'). Reading one's own crew's last
-- inbound time reveals nothing a manager does not already know.

comment on column workers.last_inbound_at is
  'Last inbound WhatsApp message from this worker. Written only by the webhook on the service role; decides template vs free-form on the daily briefing. Null = no inbound on record = send a template.';
comment on column profiles.last_inbound_at is
  'Last inbound WhatsApp message from this manager. Written only by the webhook on the service role; decides template vs free-form on the daily briefing. Null = no inbound on record = send a template.';
