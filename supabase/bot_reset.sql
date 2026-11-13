-- UpTrade strategy bots: FULL RESET for strategy v3. Run once in Supabase → SQL Editor, AFTER
-- bot.sql and BEFORE deploying the new bot-tick.
--
-- WARNING: this permanently deletes every bot account, every bot trade (open and closed), the
-- event log, all analysis reports, and the learning data of the older versions (lessons,
-- replayed signals, resting orders, news, playbooks). It cannot be undone. Manual trading
-- (schema.sql tables) and your bot settings (on/off, start balance, risk) are not touched.
--
-- After it, the next bot-tick run creates the fresh accounts: five rule sets × 15m, 1h, 4h,
-- each with the start balance from bot_settings ($100 by default).

begin;

-- Accounts first: their trades and events go with them (on delete cascade).
delete from public.bot_accounts;
delete from public.bot_events;
delete from public.bot_cursors;
delete from public.bot_reports;
-- The old rule sets. bot-tick writes the five new ones on its next run.
delete from public.bot_strategies;

-- Tables only the older versions used.
drop table if exists public.bot_pending_entries;
drop table if exists public.bot_filtered_signals;
drop table if exists public.bot_lessons;
drop table if exists public.bot_news;

-- Columns only the older versions used.
alter table public.bot_accounts
  drop column if exists probation, drop column if exists probation_changed_at,
  drop column if exists min_confluence, drop column if exists min_confluence_changed_at,
  drop column if exists breakeven, drop column if exists breakeven_changed_at,
  drop column if exists conviction, drop column if exists life, drop column if exists life_started_at,
  drop column if exists playbook, drop column if exists redeploy_requested_at;
alter table public.bot_trades
  drop column if exists life, drop column if exists aggro, drop column if exists learned_at;
alter table public.bot_settings drop column if exists auto_learn;

update public.bot_runtime set locked_until = null, last_error = null, last_summary = null where id = 1;

commit;

notify pgrst, 'reload schema';
