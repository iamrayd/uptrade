-- Schedules the strategy bots to run every minute. Run in Supabase → SQL Editor
-- AFTER deploying the bot-tick edge function (see docs/strategies/SETUP.md).
--
-- Before running, replace the two placeholders below:
--   <PROJECT_REF>      your project ref (from the Project URL https://<PROJECT_REF>.supabase.co)
--   <BOT_CRON_SECRET>  the same value you set with `supabase secrets set BOT_CRON_SECRET=...`

create extension if not exists pg_cron;
create extension if not exists pg_net;

-- Keep the secret in Vault instead of in the cron job text.
select vault.create_secret('<BOT_CRON_SECRET>', 'bot_cron_secret')
 where not exists (select 1 from vault.secrets where name = 'bot_cron_secret');

select cron.unschedule(jobid) from cron.job where jobname in ('uptrade-bot-tick', 'uptrade-bot-prune', 'uptrade-bot-analyze');

select cron.schedule(
  'uptrade-bot-tick',
  '* * * * *',
  $$
  select net.http_post(
    url := 'https://<PROJECT_REF>.supabase.co/functions/v1/bot-tick',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-bot-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'bot_cron_secret')
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 150000
  );
  $$
);

-- Hourly, a few minutes past the hour: trade reviews, learning and reports (needs the
-- bot-analyze function deployed, see docs/strategies/ANALYSIS.md).
select cron.schedule(
  'uptrade-bot-analyze',
  '7 * * * *',
  $$
  select net.http_post(
    url := 'https://<PROJECT_REF>.supabase.co/functions/v1/bot-analyze',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-bot-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'bot_cron_secret')
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 150000
  );
  $$
);

-- Daily: drop old "skipped"/"missed" log lines and hourly reports (trades are never pruned).
select cron.schedule('uptrade-bot-prune', '17 3 * * *', $$ select public.bot_prune_events(); $$);

-- Check it's running (a row per minute, status 'succeeded'):
--   select * from cron.job_run_details where jobid = (select jobid from cron.job where jobname = 'uptrade-bot-tick') order by start_time desc limit 5;
-- And what the function answered:
--   select id, status_code, content, created from net._http_response order by created desc limit 5;
-- Stop the bots entirely:
--   select cron.unschedule('uptrade-bot-tick');
