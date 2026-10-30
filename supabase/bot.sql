-- UpTrade strategy bots. Run in Supabase → SQL Editor AFTER schema.sql (it uses
-- public._liq_price and the fee helpers from there). Safe to re-run.
--
-- Each (strategy × timeframe) is its own isolated paper account ("bot account")
-- with its own balance, so results can be compared fairly. The bot-tick edge
-- function (supabase/functions/bot-tick) runs every minute from pg_cron (see
-- bot_cron.sql), reads closed Binance candles and calls the engine functions
-- below. Every trade stores why it was entered, the indicator readings, the
-- risk plan, every stop move and why it exited.
--
-- Accounting matches the manual engine: isolated margin, taker 0.02% on market
-- and stop fills, maker 0% on take-profit limit fills, MMR 0.5%, and a loss can
-- never exceed the trade's margin.

-- ───────────────────────────── Tables ─────────────────────────────

create table if not exists public.bot_settings (
  user_id        uuid primary key default auth.uid() references auth.users on delete cascade,
  enabled        boolean not null default true,              -- false: no new entries (open trades are still managed)
  start_balance  numeric(24,8) not null default 100 check (start_balance > 0),
  risk_pct       numeric(6,4)  not null default 0.02 check (risk_pct > 0 and risk_pct <= 0.1),
  max_leverage   smallint      not null default 20 check (max_leverage between 1 and 125),
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

create table if not exists public.bot_strategies (
  key         text primary key,
  name        text not null,
  version     int  not null,
  summary     text not null,
  rules       text not null,
  params      jsonb not null default '{}',
  updated_at  timestamptz not null default now()
);

create table if not exists public.bot_accounts (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null references auth.users on delete cascade,
  strategy       text not null references public.bot_strategies on delete cascade,
  timeframe      text not null check (timeframe in ('5m','15m','30m','1h','4h','1d')),
  balance        numeric(24,8) not null check (balance >= 0),   -- free cash (excludes margin in open trades)
  start_balance  numeric(24,8) not null,
  status         text not null default 'active' check (status in ('active', 'busted')),
  created_at     timestamptz not null default now(),
  unique (user_id, strategy, timeframe)
);

create table if not exists public.bot_trades (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid not null references auth.users on delete cascade,
  account_id        uuid not null references public.bot_accounts on delete cascade,
  strategy          text not null,
  timeframe         text not null,
  symbol            text not null,
  side              text not null check (side in ('long', 'short')),
  status            text not null default 'open' check (status in ('open', 'closed')),
  qty               numeric(28,10) not null check (qty > 0),
  entry_price       numeric(28,10) not null check (entry_price > 0),
  leverage          smallint not null check (leverage between 1 and 125),
  margin            numeric(24,8) not null,
  liq_price         numeric(28,10) not null,
  initial_stop      numeric(28,10) not null,
  stop_price        numeric(28,10) not null,          -- current (trailed) stop
  take_profit       numeric(28,10),                   -- null: no fixed target
  risk_usd          numeric(24,8) not null,           -- loss at the initial stop incl. fees
  risk_pct          numeric(8,6) not null,            -- risk_usd ÷ account equity at entry
  entry_fee         numeric(24,8) not null,
  signal_bar_time   timestamptz not null,             -- open time of the bar that produced the signal
  opened_at         timestamptz not null default now(),
  entry_reason      text not null,
  entry_indicators  jsonb not null default '{}',
  sizing_notes      text[] not null default '{}',
  trailed           boolean not null default false,
  stop_history      jsonb not null default '[]',      -- [{at, from, to, note}]
  checked_until     timestamptz not null,             -- 1m candles before this were checked for stop/target
  mfe_price         numeric(28,10),                   -- best price reached while open
  mae_price         numeric(28,10),                   -- worst price reached while open
  exit_price        numeric(28,10),
  exit_fee          numeric(24,8),
  closed_at         timestamptz,
  exit_reason       text check (exit_reason in ('stop_loss','trailing_stop','take_profit','signal','time_exit','liquidation')),
  exit_note         text,
  realized_pnl      numeric(24,8),                    -- gross price PnL
  net_pnl           numeric(24,8),                    -- after entry and exit fees
  r_multiple        numeric(12,4)                     -- net_pnl ÷ risk_usd
);

create unique index if not exists bot_trades_one_open
  on public.bot_trades (account_id, symbol) where status = 'open';
create index if not exists bot_trades_account_idx on public.bot_trades (account_id, opened_at desc);
create index if not exists bot_trades_user_idx on public.bot_trades (user_id, status, closed_at desc);

create table if not exists public.bot_events (
  id          bigint generated always as identity primary key,
  user_id     uuid references auth.users on delete cascade,  -- null: system event (e.g. a market-data error)
  account_id  uuid references public.bot_accounts on delete cascade,
  trade_id    uuid references public.bot_trades on delete cascade,
  symbol      text,
  timeframe   text,
  kind        text not null,       -- opened | closed | skipped | stop_moved | missed_bar | error
  message     text not null,
  data        jsonb not null default '{}',
  created_at  timestamptz not null default now()
);
create index if not exists bot_events_user_idx on public.bot_events (user_id, created_at desc);
create index if not exists bot_events_account_idx on public.bot_events (account_id, created_at desc);

-- Last closed bar each (timeframe, symbol) was evaluated on, e.g. key '15m:BTCUSDT'.
create table if not exists public.bot_cursors (
  key       text primary key,
  bar_time  timestamptz not null
);

-- One row: run lock and health.
create table if not exists public.bot_runtime (
  id                int primary key default 1 check (id = 1),
  locked_until      timestamptz,
  last_started_at   timestamptz,
  last_finished_at  timestamptz,
  last_error        text,
  last_summary      jsonb,
  runs              bigint not null default 0
);
insert into public.bot_runtime (id) values (1) on conflict (id) do nothing;

-- ───────────────────────────── Analysis & learning ─────────────────────────────
-- Written by the bot-analyze edge function (hourly). See docs/strategies/ANALYSIS.md.

-- When true, lessons confirmed on newer trades are switched on automatically.
alter table public.bot_settings add column if not exists auto_learn boolean not null default true;
-- Post-mortem of a closed trade: what went wrong, why, and the fix (analysis.ts → TradeReview).
alter table public.bot_trades add column if not exists review jsonb;
create index if not exists bot_trades_unreviewed_idx on public.bot_trades (closed_at) where status = 'closed' and review is null;

-- Entry filters learned from losing trades: "skip <strategy> [<timeframe>] entries when <feature> <op> <value>".
create table if not exists public.bot_lessons (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references auth.users on delete cascade,
  strategy        text not null references public.bot_strategies on delete cascade,
  timeframe       text,                                  -- null: every timeframe of the strategy
  feature         text not null,
  op              text not null check (op in ('lt', 'gte', 'eq')),
  value           jsonb not null,                        -- number or string
  status          text not null default 'proposed' check (status in ('proposed', 'active', 'retired', 'rejected')),
  source          text not null default 'mined' check (source in ('mined', 'ai')),
  title           text not null,
  explanation     text not null,
  evidence        jsonb not null default '{}',           -- train/test stats it was confirmed with
  blocked         int not null default 0,                -- blocked signals whose outcome is known
  blocked_r       numeric(14,4) not null default 0,      -- what they would have made, in R
  retired_reason  text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  activated_at    timestamptz
);
create unique index if not exists bot_lessons_rule_uq
  on public.bot_lessons (user_id, strategy, coalesce(timeframe, '*'), feature, op);

-- Signals a lesson blocked, and what they would have done (filled in later by the analyzer).
create table if not exists public.bot_filtered_signals (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid not null references auth.users on delete cascade,
  account_id       uuid not null references public.bot_accounts on delete cascade,
  lesson_ids       uuid[] not null,
  strategy         text not null,
  timeframe        text not null,
  symbol           text not null,
  side             text not null check (side in ('long', 'short')),
  entry_price      numeric(28,10) not null,
  stop_price       numeric(28,10) not null,
  take_profit      numeric(28,10),
  signal_bar_time  timestamptz not null,
  features         jsonb not null default '{}',
  created_at       timestamptz not null default now(),
  outcome_r        numeric(12,4),
  outcome_note     text,
  resolved_at      timestamptz
);
create index if not exists bot_filtered_open_idx on public.bot_filtered_signals (created_at) where resolved_at is null;
create index if not exists bot_filtered_user_idx on public.bot_filtered_signals (user_id, created_at desc);

-- Every signal a bot did not trade is kept and replayed, not only the ones a lesson blocked: they are the
-- data a busted or heavily filtered bot keeps learning from.
-- reason = lesson | confluence | cooldown | news | busted | probation | min_stop.
alter table public.bot_filtered_signals add column if not exists reason text not null default 'lesson';
create index if not exists bot_filtered_resolved_idx on public.bot_filtered_signals (resolved_at desc) where resolved_at is not null;
-- The replay's R with the breakeven-stop variant (stop to fee cover at +1R), next to the plain outcome_r,
-- so the analyzer can judge the breakeven rule on the same signals.
alter table public.bot_filtered_signals add column if not exists outcome_r_be numeric(12,4);

-- A lesson the owner paused is not switched back on automatically; one that only lacked room is.
alter table public.bot_lessons add column if not exists paused boolean not null default false;

-- ── Per-setup tuning (written hourly by bot-analyze, read every minute by bot-tick) ──
-- probation: the setup trades shadow-only (signals are logged and replayed, no capital is used)
-- until its replayed entries prove an edge. New 5m/15m/30m setups start on probation: the year
-- replay showed they lose money after slippage (docs/strategies/EVIDENCE.md).
alter table public.bot_accounts add column if not exists probation boolean not null default false;
alter table public.bot_accounts add column if not exists probation_changed_at timestamptz;
-- Per-setup confluence threshold learned from the setup's own entries (null: the global default).
alter table public.bot_accounts add column if not exists min_confluence int check (min_confluence between 65 and 80);
alter table public.bot_accounts add column if not exists min_confluence_changed_at timestamptz;
-- Learned exit management: move the stop to breakeven (fee cover) once the trade reaches +1R.
alter table public.bot_accounts add column if not exists breakeven boolean not null default false;
alter table public.bot_accounts add column if not exists breakeven_changed_at timestamptz;
-- Conviction-weighted sizing (risk is scaled by entry confluence and the setup's verdict).
alter table public.bot_accounts add column if not exists conviction boolean not null default true;
-- The setup's latest verdict from the analyzer (live_ready | promising | unproven | needs_data | avoid).
alter table public.bot_accounts add column if not exists verdict text;

-- Seed probation for the short timeframes (one-time: only rows that have never been tuned).
update public.bot_accounts set probation = true, probation_changed_at = now()
 where timeframe in ('5m','15m','30m') and probation = false and probation_changed_at is null;

-- Latest crypto-news read (one row), written every few minutes by the bot-news function.
create table if not exists public.bot_news (
  id          int primary key default 1 check (id = 1),
  updated_at  timestamptz not null default now(),
  data        jsonb not null default '{}'
);
alter table public.bot_news enable row level security;
drop policy if exists "read news" on public.bot_news;
create policy "read news" on public.bot_news for select to authenticated using (true);

-- Hourly / daily / weekly / monthly analysis reports.
create table if not exists public.bot_reports (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth.users on delete cascade,
  kind          text not null check (kind in ('hourly', 'daily', 'weekly', 'monthly')),
  period_start  timestamptz not null,
  period_end    timestamptz not null,
  data          jsonb not null,           -- stats, rankings, mistakes, timing, lessons
  narrative     jsonb,                    -- headline, summary, coaching (AI or template)
  ai_model      text,                     -- null: the narrative is the built-in template
  ai_error      text,
  created_at    timestamptz not null default now(),
  unique (user_id, kind, period_start)
);
create index if not exists bot_reports_user_idx on public.bot_reports (user_id, kind, period_start desc);

-- ───────────────────────────── RLS ─────────────────────────────
-- The app reads its own bot data. Only the service role (the edge function) writes,
-- except bot_settings, which the owner can create and change.

alter table public.bot_settings   enable row level security;
alter table public.bot_strategies enable row level security;
alter table public.bot_accounts   enable row level security;
alter table public.bot_trades     enable row level security;
alter table public.bot_events     enable row level security;
alter table public.bot_cursors    enable row level security;
alter table public.bot_runtime    enable row level security;

drop policy if exists "own settings" on public.bot_settings;
create policy "own settings" on public.bot_settings for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists "read strategies" on public.bot_strategies;
create policy "read strategies" on public.bot_strategies for select to authenticated using (true);

drop policy if exists "read own accounts" on public.bot_accounts;
create policy "read own accounts" on public.bot_accounts for select to authenticated using (user_id = auth.uid());

drop policy if exists "read own trades" on public.bot_trades;
create policy "read own trades" on public.bot_trades for select to authenticated using (user_id = auth.uid());

drop policy if exists "read own events" on public.bot_events;
create policy "read own events" on public.bot_events for select to authenticated
  using (user_id = auth.uid() or user_id is null);

drop policy if exists "read runtime" on public.bot_runtime;
create policy "read runtime" on public.bot_runtime for select to authenticated using (true);
alter table public.bot_lessons          enable row level security;
alter table public.bot_filtered_signals enable row level security;
alter table public.bot_reports          enable row level security;

drop policy if exists "read own lessons" on public.bot_lessons;
create policy "read own lessons" on public.bot_lessons for select to authenticated using (user_id = auth.uid());
drop policy if exists "read own filtered signals" on public.bot_filtered_signals;
create policy "read own filtered signals" on public.bot_filtered_signals for select to authenticated using (user_id = auth.uid());
drop policy if exists "read own reports" on public.bot_reports;
create policy "read own reports" on public.bot_reports for select to authenticated using (user_id = auth.uid());
-- bot_cursors: no policy, so the app can't read or write it.

-- ───────────────────────────── Engine (service role only) ─────────────────────────────

-- Takes the run lock for p_ttl seconds. Returns false if another run holds it.
create or replace function public.bot_lock(p_ttl int)
returns boolean language plpgsql set search_path = public as $$
begin
  update public.bot_runtime
     set locked_until = now() + make_interval(secs => p_ttl),
         last_started_at = now(),
         runs = runs + 1
   where id = 1 and (locked_until is null or locked_until < now());
  return found;
end $$;

create or replace function public.bot_unlock(p_error text, p_summary jsonb default null)
returns void language sql set search_path = public as $$
  update public.bot_runtime
     set locked_until = null, last_finished_at = now(), last_error = p_error, last_summary = p_summary
   where id = 1;
$$;

-- Upserts strategy metadata from code and creates any missing $start_balance
-- accounts (strategy × timeframe) for every user with bots enabled.
create or replace function public.bot_sync(p_strategies jsonb, p_timeframes text[])
returns void language plpgsql set search_path = public as $$
begin
  insert into public.bot_strategies (key, name, version, summary, rules, params, updated_at)
  select s->>'key', s->>'name', (s->>'version')::int, s->>'summary', s->>'rules', coalesce(s->'params', '{}'), now()
    from jsonb_array_elements(p_strategies) s
  on conflict (key) do update set
    name = excluded.name, version = excluded.version, summary = excluded.summary,
    rules = excluded.rules, params = excluded.params, updated_at = now();

  -- New 5m/15m/30m accounts start on probation (shadow-only) until their replays prove an edge.
  insert into public.bot_accounts (user_id, strategy, timeframe, balance, start_balance, probation, probation_changed_at)
  select st.user_id, s->>'key', tf, st.start_balance, st.start_balance,
         tf in ('5m','15m','30m'), case when tf in ('5m','15m','30m') then now() end
    from public.bot_settings st
    cross join jsonb_array_elements(p_strategies) s
    cross join unnest(p_timeframes) tf
   where st.enabled
  on conflict (user_id, strategy, timeframe) do nothing;
end $$;

-- Everything a run needs in one round trip.
create or replace function public.bot_get_state()
returns jsonb language sql stable set search_path = public as $$
  select jsonb_build_object(
    'accounts', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', a.id, 'user_id', a.user_id, 'strategy', a.strategy, 'timeframe', a.timeframe,
        'balance', a.balance, 'status', a.status, 'start_balance', a.start_balance,
        'probation', a.probation, 'min_confluence', a.min_confluence,
        'breakeven', a.breakeven, 'conviction', a.conviction, 'verdict', a.verdict,
        'enabled', coalesce(s.enabled, false),
        'risk_pct', coalesce(s.risk_pct, 0.02), 'max_leverage', coalesce(s.max_leverage, 20),
        -- Latest 10 closed trades, oldest first: the engine sizes down while an account is losing and waits after a loss.
        'recent', coalesce((
          select jsonb_agg(jsonb_build_object('symbol', x.symbol, 'r', x.r_multiple, 'closed_at', x.closed_at) order by x.closed_at)
            from (select symbol, r_multiple, closed_at from public.bot_trades
                   where account_id = a.id and status = 'closed' order by closed_at desc limit 10) x), '[]')))
      from public.bot_accounts a left join public.bot_settings s on s.user_id = a.user_id), '[]'),
    'open_trades', coalesce((
      select jsonb_agg(to_jsonb(t)) from public.bot_trades t where t.status = 'open'), '[]'),
    'cursors', coalesce((select jsonb_object_agg(key, bar_time) from public.bot_cursors), '{}'),
    'lessons', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', l.id, 'user_id', l.user_id, 'strategy', l.strategy, 'timeframe', l.timeframe,
        'feature', l.feature, 'op', l.op, 'value', l.value, 'title', l.title))
      from public.bot_lessons l where l.status = 'active'), '[]'),
    'news', (select data || jsonb_build_object('updated_at', updated_at) from public.bot_news where id = 1)
  )
$$;

create or replace function public.bot_set_cursor(p_key text, p_bar_time timestamptz)
returns void language sql set search_path = public as $$
  insert into public.bot_cursors (key, bar_time) values (p_key, p_bar_time)
  on conflict (key) do update set bar_time = greatest(public.bot_cursors.bar_time, excluded.bar_time);
$$;

-- Opens a trade at market (taker fee). Returns {trade, balance}.
create or replace function public.bot_open_trade(p jsonb)
returns jsonb language plpgsql set search_path = public as $$
declare
  v_acc     public.bot_accounts;
  v_side    text := p->>'side';
  v_qty     numeric := (p->>'qty')::numeric;
  v_price   numeric := (p->>'entry_price')::numeric;
  v_lev     int := (p->>'leverage')::int;
  v_stop    numeric := (p->>'stop_price')::numeric;
  v_tp      numeric := nullif(p->>'take_profit', '')::numeric;
  v_at      timestamptz := coalesce((p->>'opened_at')::timestamptz, now());
  v_margin  numeric;
  v_fee     numeric;
  v_trade   public.bot_trades;
begin
  select * into v_acc from public.bot_accounts where id = (p->>'account_id')::uuid for update;
  if not found then raise exception 'bot account not found'; end if;
  if v_acc.status <> 'active' then raise exception 'bot account is %', v_acc.status; end if;
  if v_side not in ('long', 'short') then raise exception 'invalid side'; end if;
  if v_qty is null or v_qty <= 0 or v_price is null or v_price <= 0 then raise exception 'invalid quantity or price'; end if;
  if v_lev is null or v_lev < 1 or v_lev > 125 then raise exception 'invalid leverage'; end if;
  if (v_side = 'long' and v_stop >= v_price) or (v_side = 'short' and v_stop <= v_price) then
    raise exception 'stop on the wrong side of entry';
  end if;
  if v_tp is not null and ((v_side = 'long' and v_tp <= v_price) or (v_side = 'short' and v_tp >= v_price)) then
    raise exception 'target on the wrong side of entry';
  end if;

  v_margin := v_qty * v_price / v_lev;
  v_fee    := v_qty * v_price * public._taker_fee();
  if v_acc.balance < v_margin + v_fee then raise exception 'insufficient balance'; end if;

  insert into public.bot_trades (
    user_id, account_id, strategy, timeframe, symbol, side, qty, entry_price, leverage, margin, liq_price,
    initial_stop, stop_price, take_profit, risk_usd, risk_pct, entry_fee, signal_bar_time, opened_at,
    entry_reason, entry_indicators, sizing_notes, checked_until, mfe_price, mae_price)
  values (
    v_acc.user_id, v_acc.id, v_acc.strategy, v_acc.timeframe, upper(p->>'symbol'), v_side, v_qty, v_price, v_lev, v_margin,
    coalesce(public._liq_price(v_side, v_price, v_qty, v_margin), 0),
    v_stop, v_stop, v_tp, (p->>'risk_usd')::numeric, (p->>'risk_pct')::numeric, v_fee,
    (p->>'signal_bar_time')::timestamptz, v_at,
    p->>'entry_reason', coalesce(p->'entry_indicators', '{}'),
    coalesce(array(select jsonb_array_elements_text(p->'sizing_notes')), '{}'),
    date_trunc('minute', v_at), v_price, v_price)
  returning * into v_trade;

  update public.bot_accounts set balance = balance - v_margin - v_fee where id = v_acc.id
    returning * into v_acc;

  insert into public.bot_events (user_id, account_id, trade_id, symbol, timeframe, kind, message, data)
  values (v_acc.user_id, v_acc.id, v_trade.id, v_trade.symbol, v_trade.timeframe, 'opened',
          initcap(v_side) || ' ' || v_trade.symbol || ' @ ' || trim_scale(v_price)::text || ' — ' || v_trade.entry_reason,
          jsonb_build_object('qty', v_qty, 'leverage', v_lev, 'stop', v_stop, 'take_profit', v_tp, 'risk_usd', v_trade.risk_usd));

  return jsonb_build_object('trade', to_jsonb(v_trade), 'balance', v_acc.balance);
end $$;

-- Closes an open trade. Liquidations fill at the trade's liq price and forfeit
-- the whole margin. Returns {trade, balance}, or null if it was already closed.
create or replace function public.bot_close_trade(
  p_trade_id uuid, p_price numeric, p_reason text, p_fee_rate numeric, p_at timestamptz, p_note text)
returns jsonb language plpgsql set search_path = public as $$
declare
  v_t       public.bot_trades;
  v_acc     public.bot_accounts;
  v_price   numeric := p_price;
  v_pnl     numeric;
  v_fee     numeric;
  v_net     numeric;
  v_equity  numeric;
begin
  select * into v_t from public.bot_trades where id = p_trade_id and status = 'open' for update;
  if not found then return null; end if;
  select * into v_acc from public.bot_accounts where id = v_t.account_id for update;

  if p_reason = 'liquidation' then v_price := v_t.liq_price; end if;
  if v_price is null or v_price <= 0 then raise exception 'invalid exit price'; end if;

  v_pnl := case when v_t.side = 'long' then (v_price - v_t.entry_price) * v_t.qty
                else (v_t.entry_price - v_price) * v_t.qty end;
  v_fee := v_price * v_t.qty * coalesce(p_fee_rate, 0);
  if p_reason = 'liquidation' then
    v_pnl := greatest(v_pnl, -v_t.margin);
    v_fee := v_t.margin + v_pnl;
  elsif v_t.margin + v_pnl < 0 then
    v_pnl := -v_t.margin;
    v_fee := 0;
  elsif v_t.margin + v_pnl < v_fee then
    v_fee := v_t.margin + v_pnl;
  end if;
  v_net := v_pnl - v_t.entry_fee - v_fee;

  update public.bot_trades set
    status       = 'closed',
    exit_price   = v_price,
    exit_fee     = v_fee,
    closed_at    = greatest(coalesce(p_at, now()), v_t.opened_at),
    exit_reason  = p_reason,
    exit_note    = p_note,
    realized_pnl = v_pnl,
    net_pnl      = v_net,
    r_multiple   = case when v_t.risk_usd > 0 then v_net / v_t.risk_usd end,
    mfe_price    = case when v_t.side = 'long' then greatest(mfe_price, v_price) else least(mfe_price, v_price) end,
    mae_price    = case when v_t.side = 'long' then least(mae_price, v_price) else greatest(mae_price, v_price) end
  where id = v_t.id
  returning * into v_t;

  update public.bot_accounts set balance = balance + v_t.margin + v_pnl - v_fee where id = v_acc.id
    returning * into v_acc;

  -- Busted: under $10 of equity left, too little to trade. Open trades are still managed.
  select v_acc.balance + coalesce(sum(margin), 0) into v_equity
    from public.bot_trades where account_id = v_acc.id and status = 'open';
  if v_equity < 10 and v_acc.status = 'active' then
    update public.bot_accounts set status = 'busted' where id = v_acc.id returning * into v_acc;
  end if;

  insert into public.bot_events (user_id, account_id, trade_id, symbol, timeframe, kind, message, data)
  values (v_acc.user_id, v_acc.id, v_t.id, v_t.symbol, v_t.timeframe, 'closed',
          'Closed ' || v_t.side || ' ' || v_t.symbol || ' @ ' || trim_scale(round(v_price, 8))::text || ' (' || p_reason || '): net ' ||
          round(v_net, 2)::text || ' USDT, ' || coalesce(round(v_t.r_multiple, 2)::text, '?') || 'R',
          jsonb_build_object('net_pnl', v_net, 'r', v_t.r_multiple, 'balance', v_acc.balance, 'status', v_acc.status));

  return jsonb_build_object('trade', to_jsonb(v_t), 'balance', v_acc.balance, 'status', v_acc.status);
end $$;

-- Batch update of open trades: [{id, stop_price?, trailed?, mfe_price?, mae_price?, checked_until?, stop_event?}]
create or replace function public.bot_update_trades(p jsonb)
returns void language plpgsql set search_path = public as $$
declare u jsonb;
begin
  for u in select * from jsonb_array_elements(p) loop
    update public.bot_trades set
      stop_price    = coalesce((u->>'stop_price')::numeric, stop_price),
      trailed       = coalesce((u->>'trailed')::boolean, trailed),
      mfe_price     = coalesce((u->>'mfe_price')::numeric, mfe_price),
      mae_price     = coalesce((u->>'mae_price')::numeric, mae_price),
      checked_until = greatest(checked_until, coalesce((u->>'checked_until')::timestamptz, checked_until)),
      stop_history  = case when u ? 'stop_event' then stop_history || jsonb_build_array(u->'stop_event') else stop_history end
    where id = (u->>'id')::uuid and status = 'open';
  end loop;
end $$;

-- Batch insert of events: [{user_id?, account_id?, trade_id?, symbol?, timeframe?, kind, message, data?}]
create or replace function public.bot_log(p jsonb)
returns void language sql set search_path = public as $$
  insert into public.bot_events (user_id, account_id, trade_id, symbol, timeframe, kind, message, data)
  select (e->>'user_id')::uuid, (e->>'account_id')::uuid, (e->>'trade_id')::uuid, e->>'symbol', e->>'timeframe',
         e->>'kind', e->>'message', coalesce(e->'data', '{}')
    from jsonb_array_elements(p) e;
$$;

-- Batch insert of signals the bot did not trade: [{account_id, reason?, lesson_ids?, symbol, side, entry_price, stop_price, take_profit?, signal_bar_time, features}]
create or replace function public.bot_log_filtered(p jsonb)
returns void language sql set search_path = public as $$
  insert into public.bot_filtered_signals (user_id, account_id, lesson_ids, strategy, timeframe, symbol, side,
    entry_price, stop_price, take_profit, signal_bar_time, features, reason)
  select a.user_id, a.id, array(select jsonb_array_elements_text(coalesce(e->'lesson_ids', '[]')))::uuid[], a.strategy, a.timeframe,
         upper(e->>'symbol'), e->>'side', (e->>'entry_price')::numeric, (e->>'stop_price')::numeric,
         nullif(e->>'take_profit', '')::numeric, (e->>'signal_bar_time')::timestamptz, coalesce(e->'features', '{}'),
         coalesce(e->>'reason', 'lesson')
    from jsonb_array_elements(p) e
    join public.bot_accounts a on a.id = (e->>'account_id')::uuid;
$$;

-- Everything the analyzer needs in one round trip.
create or replace function public.bot_analysis_state()
returns jsonb language sql stable set search_path = public as $$
  select jsonb_build_object(
    'settings', coalesce((select jsonb_agg(jsonb_build_object('user_id', user_id, 'auto_learn', auto_learn)) from public.bot_settings), '[]'),
    'accounts', coalesce((
      select jsonb_agg(jsonb_build_object('id', id, 'user_id', user_id, 'strategy', strategy, 'timeframe', timeframe,
                                          'start_balance', start_balance, 'status', status,
                                          'probation', probation, 'probation_changed_at', probation_changed_at,
                                          'min_confluence', min_confluence, 'min_confluence_changed_at', min_confluence_changed_at,
                                          'breakeven', breakeven, 'breakeven_changed_at', breakeven_changed_at,
                                          'conviction', conviction, 'verdict', verdict))
        from public.bot_accounts), '[]'),
    'trades', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', t.id, 'user_id', t.user_id, 'account_id', t.account_id, 'strategy', t.strategy, 'timeframe', t.timeframe,
        'symbol', t.symbol, 'side', t.side, 'qty', t.qty, 'entry_price', t.entry_price, 'initial_stop', t.initial_stop,
        'take_profit', t.take_profit, 'risk_usd', t.risk_usd, 'opened_at', t.opened_at, 'closed_at', t.closed_at,
        'exit_reason', t.exit_reason, 'exit_price', t.exit_price, 'exit_note', t.exit_note, 'net_pnl', t.net_pnl,
        'r_multiple', t.r_multiple, 'mfe_price', t.mfe_price, 'mae_price', t.mae_price,
        'entry_indicators', t.entry_indicators, 'reviewed', t.review is not null,
        'review_category', t.review->>'category',
        'review', case when t.closed_at > now() - interval '35 days' then t.review end) order by t.closed_at)
        from public.bot_trades t where t.status = 'closed'), '[]'),
    'lessons', coalesce((select jsonb_agg(to_jsonb(l)) from public.bot_lessons l), '[]'),
    'pending_signals', coalesce((
      select jsonb_agg(to_jsonb(f) order by f.created_at)
        from (select * from public.bot_filtered_signals where resolved_at is null order by created_at limit 800) f), '[]'),
    -- Replayed signals are learning data (and the recent record of each lesson), newest 4000.
    'resolved_signals', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', f.id, 'user_id', f.user_id, 'account_id', f.account_id, 'strategy', f.strategy, 'timeframe', f.timeframe,
        'symbol', f.symbol, 'side', f.side, 'features', f.features, 'outcome_r', f.outcome_r, 'outcome_r_be', f.outcome_r_be, 'reason', f.reason,
        'lesson_ids', f.lesson_ids, 'signal_bar_time', f.signal_bar_time, 'resolved_at', f.resolved_at) order by f.signal_bar_time)
        from (select * from public.bot_filtered_signals where resolved_at is not null and outcome_r is not null
               order by resolved_at desc limit 4000) f), '[]'),
    'last_reports', coalesce((
      select jsonb_agg(jsonb_build_object('user_id', user_id, 'kind', kind, 'period_start', period_start))
        from (select distinct on (user_id, kind) user_id, kind, period_start
                from public.bot_reports order by user_id, kind, period_start desc) r), '[]')
  )
$$;

-- [{id, review}]
create or replace function public.bot_save_reviews(p jsonb)
returns void language sql set search_path = public as $$
  update public.bot_trades t set review = e->'review'
    from jsonb_array_elements(p) e
   where t.id = (e->>'id')::uuid and t.status = 'closed';
$$;

-- [{id, outcome_r, outcome_r_be?, outcome_note}]
create or replace function public.bot_resolve_signals(p jsonb)
returns void language sql set search_path = public as $$
  update public.bot_filtered_signals f
     set outcome_r = (e->>'outcome_r')::numeric, outcome_r_be = (e->>'outcome_r_be')::numeric,
         outcome_note = e->>'outcome_note', resolved_at = now()
    from jsonb_array_elements(p) e
   where f.id = (e->>'id')::uuid;
$$;

-- Per-setup tuning from the analyzer: [{id, probation?, min_confluence?, breakeven?, conviction?, verdict?}].
-- The *_changed_at stamps only move when the value really flips, so the 7-day hysteresis works.
create or replace function public.bot_tune_accounts(p jsonb)
returns void language plpgsql set search_path = public as $$
declare e jsonb;
begin
  for e in select * from jsonb_array_elements(p) loop
    update public.bot_accounts a set
      probation = coalesce((e->>'probation')::boolean, a.probation),
      probation_changed_at = case when e ? 'probation' and (e->>'probation')::boolean is distinct from a.probation
                                  then now() else a.probation_changed_at end,
      min_confluence = case when e ? 'min_confluence' then nullif(e->>'min_confluence', '')::int else a.min_confluence end,
      min_confluence_changed_at = case when e ? 'min_confluence' and nullif(e->>'min_confluence', '')::int is distinct from a.min_confluence
                                       then now() else a.min_confluence_changed_at end,
      breakeven = coalesce((e->>'breakeven')::boolean, a.breakeven),
      breakeven_changed_at = case when e ? 'breakeven' and (e->>'breakeven')::boolean is distinct from a.breakeven
                                  then now() else a.breakeven_changed_at end,
      conviction = coalesce((e->>'conviction')::boolean, a.conviction),
      verdict = coalesce(e->>'verdict', a.verdict)
    where a.id = (e->>'id')::uuid;
  end loop;
end $$;

-- New lessons ({user_id, strategy, timeframe, feature, op, value, status, source, title, explanation, evidence})
-- and changes to existing ones ({id, status?, blocked?, blocked_r?, retired_reason?}).
create or replace function public.bot_save_lessons(p jsonb)
returns void language plpgsql set search_path = public as $$
declare e jsonb;
begin
  for e in select * from jsonb_array_elements(p) loop
    if e ? 'id' then
      update public.bot_lessons set
        status         = coalesce(e->>'status', status),
        blocked        = coalesce((e->>'blocked')::int, blocked),
        blocked_r      = coalesce((e->>'blocked_r')::numeric, blocked_r),
        retired_reason = coalesce(e->>'retired_reason', retired_reason),
        activated_at   = case when e->>'status' = 'active' and activated_at is null then now() else activated_at end,
        updated_at     = now()
      where id = (e->>'id')::uuid;
    else
      insert into public.bot_lessons (user_id, strategy, timeframe, feature, op, value, status, source, title, explanation, evidence, activated_at)
      values ((e->>'user_id')::uuid, e->>'strategy', nullif(e->>'timeframe', ''), e->>'feature', e->>'op', e->'value',
              e->>'status', coalesce(e->>'source', 'mined'), e->>'title', e->>'explanation', coalesce(e->'evidence', '{}'),
              case when e->>'status' = 'active' then now() end)
      on conflict (user_id, strategy, coalesce(timeframe, '*'), feature, op) do nothing;
    end if;
  end loop;
end $$;

-- {user_id, kind, period_start, period_end, data, narrative, ai_model, ai_error}
create or replace function public.bot_save_report(p jsonb)
returns void language sql set search_path = public as $$
  insert into public.bot_reports (user_id, kind, period_start, period_end, data, narrative, ai_model, ai_error)
  values ((p->>'user_id')::uuid, p->>'kind', (p->>'period_start')::timestamptz, (p->>'period_end')::timestamptz,
          p->'data', p->'narrative', p->>'ai_model', p->>'ai_error')
  on conflict (user_id, kind, period_start) do update set
    period_end = excluded.period_end, data = excluded.data, narrative = excluded.narrative,
    ai_model = excluded.ai_model, ai_error = excluded.ai_error, created_at = now();
$$;

-- {data: {...}}: the latest crypto-news read, from the bot-news function.
create or replace function public.bot_save_news(p jsonb)
returns void language sql set search_path = public as $$
  insert into public.bot_news (id, updated_at, data) values (1, now(), coalesce(p->'data', '{}'))
  on conflict (id) do update set updated_at = now(), data = excluded.data;
$$;

-- The owner switches a lesson on, back to proposed, or rejects it for good.
create or replace function public.bot_set_lesson_status(p_id uuid, p_status text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if p_status not in ('active', 'proposed', 'rejected') then raise exception 'invalid status'; end if;
  update public.bot_lessons
     set status = p_status, updated_at = now(),
         paused = (p_status = 'proposed'),
         activated_at = case when p_status = 'active' then coalesce(activated_at, now()) else activated_at end
   where id = p_id and user_id = auth.uid();
  if not found then raise exception 'lesson not found'; end if;
end $$;
revoke all on function public.bot_set_lesson_status(uuid, text) from public, anon;
grant execute on function public.bot_set_lesson_status(uuid, text) to authenticated;

-- Supabase grants EXECUTE on new functions to anon and authenticated by default.
-- These must only be callable by the edge function (service role).
do $$
declare f text;
begin
  foreach f in array array[
    'bot_lock(int)', 'bot_unlock(text, jsonb)', 'bot_sync(jsonb, text[])', 'bot_get_state()',
    'bot_set_cursor(text, timestamptz)', 'bot_open_trade(jsonb)',
    'bot_close_trade(uuid, numeric, text, numeric, timestamptz, text)', 'bot_update_trades(jsonb)', 'bot_log(jsonb)',
    'bot_log_filtered(jsonb)', 'bot_analysis_state()', 'bot_save_reviews(jsonb)', 'bot_resolve_signals(jsonb)',
    'bot_save_lessons(jsonb)', 'bot_save_report(jsonb)', 'bot_save_news(jsonb)', 'bot_tune_accounts(jsonb)'
  ] loop
    execute format('revoke all on function public.%s from public, anon, authenticated', f);
    execute format('grant execute on function public.%s to service_role', f);
  end loop;
end $$;

-- Keep the events log from growing forever (skips are chatty on 5m).
create or replace function public.bot_prune_events()
returns void language sql set search_path = public as $$
  delete from public.bot_events where kind in ('skipped', 'missed_bar') and created_at < now() - interval '45 days';
  delete from public.bot_reports where kind = 'hourly' and period_start < now() - interval '30 days';
  -- Replayed signals older than this have already taught what they can; lessons keep their own tallies.
  delete from public.bot_filtered_signals where resolved_at is not null and resolved_at < now() - interval '90 days';
$$;
revoke all on function public.bot_prune_events() from public, anon, authenticated;
grant execute on function public.bot_prune_events() to service_role;

notify pgrst, 'reload schema';
