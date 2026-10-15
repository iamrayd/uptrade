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

  insert into public.bot_accounts (user_id, strategy, timeframe, balance, start_balance)
  select st.user_id, s->>'key', tf, st.start_balance, st.start_balance
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
        'balance', a.balance, 'status', a.status,
        'enabled', coalesce(s.enabled, false),
        'risk_pct', coalesce(s.risk_pct, 0.02), 'max_leverage', coalesce(s.max_leverage, 20)))
      from public.bot_accounts a left join public.bot_settings s on s.user_id = a.user_id), '[]'),
    'open_trades', coalesce((
      select jsonb_agg(to_jsonb(t)) from public.bot_trades t where t.status = 'open'), '[]'),
    'cursors', coalesce((select jsonb_object_agg(key, bar_time) from public.bot_cursors), '{}')
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

-- Supabase grants EXECUTE on new functions to anon and authenticated by default.
-- These must only be callable by the edge function (service role).
do $$
declare f text;
begin
  foreach f in array array[
    'bot_lock(int)', 'bot_unlock(text, jsonb)', 'bot_sync(jsonb, text[])', 'bot_get_state()',
    'bot_set_cursor(text, timestamptz)', 'bot_open_trade(jsonb)',
    'bot_close_trade(uuid, numeric, text, numeric, timestamptz, text)', 'bot_update_trades(jsonb)', 'bot_log(jsonb)'
  ] loop
    execute format('revoke all on function public.%s from public, anon, authenticated', f);
    execute format('grant execute on function public.%s to service_role', f);
  end loop;
end $$;

-- Keep the events log from growing forever (skips are chatty on 5m).
create or replace function public.bot_prune_events()
returns void language sql set search_path = public as $$
  delete from public.bot_events where kind in ('skipped', 'missed_bar') and created_at < now() - interval '45 days';
$$;
revoke all on function public.bot_prune_events() from public, anon, authenticated;
grant execute on function public.bot_prune_events() to service_role;

notify pgrst, 'reload schema';
