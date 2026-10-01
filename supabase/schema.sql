-- UpTrade schema. Run in Supabase → SQL Editor. Safe to re-run: it also upgrades
-- an existing install (adds leverage/fee columns, replaces the engine functions).
--
-- Model: USDT-margined linear perpetual-style positions, ISOLATED margin.
--   * One netted position per symbol (long or short), leverage 1–125x.
--   * Initial margin   = qty × entry / leverage
--   * Fees (MEXC futures): taker 0.02% (market, marketable limit), maker 0% (resting limit)
--   * Maintenance margin rate (MMR) = 0.5% flat
--   * Liquidation when margin + unrealized PnL ≤ MMR × qty × price, i.e.
--       long : liq = (entry − margin/qty) / (1 − MMR)
--       short: liq = (entry + margin/qty) / (1 + MMR)
--     On liquidation the position's whole isolated margin is lost (the remainder
--     after price PnL is recorded as the liquidation fee, as exchanges do).

-- ───────────────────────────── Tables ─────────────────────────────

create table if not exists public.accounts (
  user_id     uuid primary key default auth.uid() references auth.users on delete cascade,
  balance     numeric(24,8) not null default 1000 check (balance >= 0),
  created_at  timestamptz not null default now()
);

create table if not exists public.balance_adjustments (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null default auth.uid() references auth.users on delete cascade,
  amount         numeric(24,8) not null,
  note           text,
  balance_after  numeric(24,8) not null,
  created_at     timestamptz not null default now()
);

create table if not exists public.positions (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null default auth.uid() references auth.users on delete cascade,
  symbol        text not null,
  side          text not null check (side in ('long', 'short')),
  qty           numeric(28,10) not null check (qty >= 0),   -- currently open
  entry_qty     numeric(28,10) not null,                    -- total ever opened
  closed_qty    numeric(28,10) not null default 0,
  avg_entry     numeric(28,10) not null,
  avg_exit      numeric(28,10),
  realized_pnl  numeric(24,8) not null default 0,           -- gross price PnL (before fees)
  status        text not null default 'open' check (status in ('open', 'closed')),
  opened_at     timestamptz not null default now(),
  closed_at     timestamptz,
  check (status = 'closed' or qty > 0)
);

create table if not exists public.orders (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null default auth.uid() references auth.users on delete cascade,
  symbol         text not null,
  side           text not null check (side in ('buy', 'sell')),
  type           text not null,
  qty            numeric(28,10) not null check (qty > 0),
  limit_price    numeric(28,10) check (limit_price is null or limit_price > 0),
  status         text not null default 'open' check (status in ('open', 'filled', 'cancelled')),
  fill_price     numeric(28,10),
  cancel_reason  text,
  created_at     timestamptz not null default now(),
  filled_at      timestamptz
);

create table if not exists public.fills (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null default auth.uid() references auth.users on delete cascade,
  order_id      uuid not null references public.orders on delete cascade,
  position_id   uuid not null references public.positions on delete cascade,
  symbol        text not null,
  side          text not null check (side in ('buy', 'sell')),
  qty           numeric(28,10) not null,
  price         numeric(28,10) not null,
  realized_pnl  numeric(24,8) not null default 0,
  created_at    timestamptz not null default now()
);

create table if not exists public.journal_entries (
  position_id  uuid primary key references public.positions on delete cascade,
  user_id      uuid not null default auth.uid() references auth.users on delete cascade,
  notes        text not null default '',
  tags         text[] not null default '{}',
  rating       smallint check (rating between 1 and 5),
  screenshots  text[] not null default '{}',
  updated_at   timestamptz not null default now()
);

-- ── v2: leverage, isolated margin, fees, liquidation ──

alter table public.positions add column if not exists leverage      smallint      not null default 1;
alter table public.positions add column if not exists margin        numeric(24,8) not null default 0;  -- isolated margin held
alter table public.positions add column if not exists fees          numeric(24,8) not null default 0;  -- all fees paid
alter table public.positions add column if not exists liq_price     numeric(28,10);                    -- 0 = cannot liquidate
alter table public.positions add column if not exists close_reason  text;                              -- 'closed' | 'liquidated'
alter table public.positions add column if not exists last_fill_at  timestamptz;                       -- when liq_price last changed

alter table public.orders add column if not exists leverage smallint      not null default 1;
alter table public.orders add column if not exists fee      numeric(24,8) not null default 0;

alter table public.fills add column if not exists fee numeric(24,8) not null default 0;

alter table public.orders drop constraint if exists orders_type_check;
alter table public.orders add constraint orders_type_check check (type in ('market', 'limit', 'liquidation'));
alter table public.orders drop constraint if exists orders_leverage_check;
alter table public.orders add constraint orders_leverage_check check (leverage between 1 and 125);
alter table public.positions drop constraint if exists positions_leverage_check;
alter table public.positions add constraint positions_leverage_check check (leverage between 1 and 125);

create unique index if not exists positions_one_open_per_symbol
  on public.positions (user_id, symbol) where status = 'open';
create index if not exists positions_history_idx
  on public.positions (user_id, status, closed_at desc);
create index if not exists orders_status_idx on public.orders (user_id, status);
create index if not exists fills_position_idx on public.fills (position_id, created_at);

-- ───────────────────────────── Constants & helpers ─────────────────────────────

create or replace function public._mmr() returns numeric language sql immutable as $$ select 0.005::numeric $$;
create or replace function public._taker_fee() returns numeric language sql immutable as $$ select 0.0002::numeric $$;
create or replace function public._maker_fee() returns numeric language sql immutable as $$ select 0::numeric $$;

-- Isolated-margin liquidation price (see header). 0 means "never" (e.g. a 1x long).
create or replace function public._liq_price(p_side text, p_entry numeric, p_qty numeric, p_margin numeric)
returns numeric language sql immutable as $$
  select case
    when p_qty <= 0 then null
    when p_side = 'long' then greatest((p_entry - p_margin / p_qty) / (1 - public._mmr()), 0)
    else (p_entry + p_margin / p_qty) / (1 + public._mmr())
  end
$$;

-- Bring v1 (fully-collateralized) open positions onto the margin model: they behave as 1x.
update public.positions
  set leverage = 1,
      margin = qty * avg_entry,
      liq_price = public._liq_price(side, avg_entry, qty, qty * avg_entry),
      last_fill_at = coalesce(last_fill_at, opened_at)
  where status = 'open' and margin = 0;
update public.positions set close_reason = 'closed' where status = 'closed' and close_reason is null;
update public.positions set last_fill_at = coalesce(last_fill_at, closed_at, opened_at) where last_fill_at is null;

-- ───────────────────────────── RLS ─────────────────────────────

do $$
declare t text;
begin
  foreach t in array array['accounts','balance_adjustments','positions','orders','fills','journal_entries'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists "own rows" on public.%I', t);
    execute format(
      'create policy "own rows" on public.%I for all to authenticated
         using (user_id = auth.uid()) with check (user_id = auth.uid())', t);
  end loop;
end $$;

-- ───────────────────────────── New user → account ─────────────────────────────

create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.accounts (user_id, balance) values (new.id, 1000)
    on conflict (user_id) do nothing;
  insert into public.balance_adjustments (user_id, amount, note, balance_after)
    values (new.id, 1000, 'Starting balance', 1000);
  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ───────────────────────────── Order engine ─────────────────────────────

-- Old v1 signatures (replaced below).
drop function if exists public._apply_fill(public.orders, numeric, timestamptz);
drop function if exists public.place_order(text, text, text, numeric, numeric, numeric);

-- Applies one fill of p_order at p_price with fee rate p_fee_rate.
--  1) Reduces/closes an opposite position: releases margin pro-rata, realizes PnL,
--     charges the closing fee. A loss can never exceed the margin released
--     (that would mean the position should already have been liquidated).
--  2) Opens/adds the remaining qty: locks qty × price / leverage as margin and
--     charges the opening fee. Adding to a position uses that position's leverage.
create or replace function public._apply_fill(p_order public.orders, p_price numeric, p_ts timestamptz, p_fee_rate numeric)
returns void language plpgsql security invoker set search_path = public as $$
declare
  v_uid        uuid := p_order.user_id;
  v_dir        text := case when p_order.side = 'buy' then 'long' else 'short' end;
  v_bal        numeric;
  v_pos        public.positions;
  v_has_pos    boolean;
  v_same       boolean := false;
  v_remaining  numeric := p_order.qty;
  v_close      numeric;
  v_pnl        numeric;
  v_release    numeric;
  v_fee        numeric;
  v_total_fee  numeric := 0;
  v_lev        smallint;
  v_margin     numeric;
  v_new_qty    numeric;
  v_new_entry  numeric;
  v_new_id     uuid;
begin
  select balance into v_bal from public.accounts where user_id = v_uid for update;
  if not found then raise exception 'account not found'; end if;

  select * into v_pos from public.positions
    where user_id = v_uid and symbol = p_order.symbol and status = 'open'
    for update;
  v_has_pos := found;

  -- 1) Reduce / close an opposite position.
  if v_has_pos and v_pos.side <> v_dir then
    v_close   := least(v_remaining, v_pos.qty);
    v_pnl     := case when v_pos.side = 'long'
                      then (p_price - v_pos.avg_entry) * v_close
                      else (v_pos.avg_entry - p_price) * v_close end;
    v_release := v_pos.margin * v_close / v_pos.qty;
    v_fee     := v_close * p_price * p_fee_rate;

    -- Isolated margin: the most this slice can lose is its margin.
    if v_release + v_pnl < 0 then
      v_pnl := -v_release;
      v_fee := 0;
    elsif v_release + v_pnl < v_fee then
      v_fee := v_release + v_pnl;
    end if;

    v_bal := v_bal + v_release + v_pnl - v_fee;
    v_total_fee := v_total_fee + v_fee;

    -- (liq price is unchanged by a pro-rata reduction: margin/qty stays the same)
    update public.positions set
      avg_exit     = (coalesce(avg_exit, 0) * closed_qty + p_price * v_close) / (closed_qty + v_close),
      closed_qty   = closed_qty + v_close,
      qty          = qty - v_close,
      margin       = case when qty - v_close = 0 then 0 else margin - v_release end,
      realized_pnl = realized_pnl + v_pnl,
      fees         = fees + v_fee,
      status       = case when qty - v_close = 0 then 'closed' else 'open' end,
      closed_at    = case when qty - v_close = 0 then p_ts end,
      close_reason = case when qty - v_close = 0 then 'closed' end,
      last_fill_at = p_ts
    where id = v_pos.id;

    insert into public.fills (user_id, order_id, position_id, symbol, side, qty, price, realized_pnl, fee, created_at)
      values (v_uid, p_order.id, v_pos.id, p_order.symbol, p_order.side, v_close, p_price, v_pnl, v_fee, p_ts);

    v_remaining := v_remaining - v_close;
  elsif v_has_pos then
    v_same := true;
  end if;

  -- 2) Open / add with the remainder.
  if v_remaining > 0 then
    v_lev    := case when v_same then v_pos.leverage else p_order.leverage end;
    v_margin := v_remaining * p_price / v_lev;
    v_fee    := v_remaining * p_price * p_fee_rate;
    if v_bal < v_margin + v_fee then
      raise exception 'insufficient balance';
    end if;
    v_bal := v_bal - v_margin - v_fee;
    v_total_fee := v_total_fee + v_fee;

    if v_same then
      v_new_qty   := v_pos.qty + v_remaining;
      v_new_entry := (v_pos.avg_entry * v_pos.qty + p_price * v_remaining) / v_new_qty;
      update public.positions set
        avg_entry    = v_new_entry,
        qty          = v_new_qty,
        entry_qty    = entry_qty + v_remaining,
        margin       = margin + v_margin,
        fees         = fees + v_fee,
        liq_price    = public._liq_price(side, v_new_entry, v_new_qty, margin + v_margin),
        last_fill_at = p_ts
      where id = v_pos.id;
      v_new_id := v_pos.id;
    else
      insert into public.positions
        (user_id, symbol, side, qty, entry_qty, avg_entry, leverage, margin, fees, liq_price, opened_at, last_fill_at)
      values
        (v_uid, p_order.symbol, v_dir, v_remaining, v_remaining, p_price, v_lev, v_margin, v_fee,
         public._liq_price(v_dir, p_price, v_remaining, v_margin), p_ts, p_ts)
      returning id into v_new_id;
    end if;

    insert into public.fills (user_id, order_id, position_id, symbol, side, qty, price, realized_pnl, fee, created_at)
      values (v_uid, p_order.id, v_new_id, p_order.symbol, p_order.side, v_remaining, p_price, 0, v_fee, p_ts);
  end if;

  update public.accounts set balance = v_bal where user_id = v_uid;

  update public.orders set status = 'filled', fill_price = p_price, filled_at = p_ts, fee = v_total_fee
    where id = p_order.id;
end $$;

-- Market orders fill now at p_market_price (taker). Limit orders that are already
-- marketable (buy limit ≥ market, sell limit ≤ market) also fill now at the market
-- price as taker, like a real exchange; otherwise they rest and later fill at the
-- limit price as maker.
create or replace function public.place_order(
  p_symbol text, p_side text, p_type text, p_qty numeric,
  p_limit_price numeric default null, p_market_price numeric default null, p_leverage int default 1)
returns public.orders language plpgsql security invoker set search_path = public as $$
declare v_order public.orders;
begin
  if auth.uid() is null then raise exception 'not authenticated'; end if;
  if p_qty is null or p_qty <= 0 then raise exception 'invalid quantity'; end if;
  if p_side not in ('buy', 'sell') then raise exception 'invalid side'; end if;
  if p_leverage is null or p_leverage < 1 or p_leverage > 125 then raise exception 'invalid leverage'; end if;

  if p_type = 'market' then
    if p_market_price is null or p_market_price <= 0 then raise exception 'invalid price'; end if;
    insert into public.orders (user_id, symbol, side, type, qty, leverage)
      values (auth.uid(), upper(p_symbol), p_side, 'market', p_qty, p_leverage)
      returning * into v_order;
    perform public._apply_fill(v_order, p_market_price, now(), public._taker_fee());
  elsif p_type = 'limit' then
    if p_limit_price is null or p_limit_price <= 0 then raise exception 'invalid price'; end if;
    insert into public.orders (user_id, symbol, side, type, qty, limit_price, leverage)
      values (auth.uid(), upper(p_symbol), p_side, 'limit', p_qty, p_limit_price, p_leverage)
      returning * into v_order;
    if p_market_price is not null and p_market_price > 0 and
       ((p_side = 'buy' and p_limit_price >= p_market_price) or
        (p_side = 'sell' and p_limit_price <= p_market_price)) then
      perform public._apply_fill(v_order, p_market_price, now(), public._taker_fee());
    end if;
  else
    raise exception 'invalid order type';
  end if;

  select * into v_order from public.orders where id = v_order.id;
  return v_order;
end $$;

-- Fills a resting limit order at its limit price (maker). No-op if already
-- filled/cancelled, so racing tabs/devices can't double-fill. A fill that fails
-- (e.g. not enough balance for the margin) cancels the order with the reason.
create or replace function public.fill_limit_order(p_order_id uuid, p_filled_at timestamptz default null)
returns public.orders language plpgsql security invoker set search_path = public as $$
declare v_order public.orders;
begin
  select * into v_order from public.orders
    where id = p_order_id and user_id = auth.uid() for update;
  if not found then raise exception 'order not found'; end if;
  if v_order.status <> 'open' or v_order.type <> 'limit' then return v_order; end if;

  begin
    perform public._apply_fill(v_order, v_order.limit_price,
      greatest(coalesce(p_filled_at, now()), v_order.created_at), public._maker_fee());
  exception when others then
    update public.orders set status = 'cancelled', cancel_reason = sqlerrm where id = v_order.id;
  end;

  select * into v_order from public.orders where id = p_order_id;
  return v_order;
end $$;

create or replace function public.cancel_order(p_order_id uuid)
returns public.orders language plpgsql security invoker set search_path = public as $$
declare v_order public.orders;
begin
  update public.orders set status = 'cancelled', cancel_reason = 'Cancelled by you'
    where id = p_order_id and user_id = auth.uid() and status = 'open'
    returning * into v_order;
  if not found then raise exception 'order not open'; end if;
  return v_order;
end $$;

create or replace function public.close_position(p_position_id uuid, p_market_price numeric)
returns public.orders language plpgsql security invoker set search_path = public as $$
declare v_pos public.positions;
begin
  select * into v_pos from public.positions
    where id = p_position_id and user_id = auth.uid() and status = 'open';
  if not found then raise exception 'position not open'; end if;
  return public.place_order(v_pos.symbol,
    case when v_pos.side = 'long' then 'sell' else 'buy' end,
    'market', v_pos.qty, null, p_market_price, v_pos.leverage);
end $$;

-- Liquidates an open position at its liquidation price. The whole isolated
-- margin is lost: price PnL at the liq price takes margin down to the
-- maintenance level, and that remainder is charged as the liquidation fee.
-- Returns null if the position is already closed (another device got there first).
create or replace function public.liquidate_position(p_position_id uuid, p_at timestamptz default null)
returns public.positions language plpgsql security invoker set search_path = public as $$
declare
  v_pos    public.positions;
  v_price  numeric;
  v_pnl    numeric;
  v_fee    numeric;
  v_ts     timestamptz;
  v_order  uuid;
  v_side   text;
begin
  select * into v_pos from public.positions
    where id = p_position_id and user_id = auth.uid() and status = 'open'
    for update;
  if not found then return null; end if;

  v_price := v_pos.liq_price;
  if v_price is null or v_price <= 0 then raise exception 'position cannot be liquidated'; end if;

  v_ts   := greatest(coalesce(p_at, now()), v_pos.last_fill_at, v_pos.opened_at);
  v_side := case when v_pos.side = 'long' then 'sell' else 'buy' end;
  v_pnl  := case when v_pos.side = 'long'
                 then (v_price - v_pos.avg_entry) * v_pos.qty
                 else (v_pos.avg_entry - v_price) * v_pos.qty end;
  v_pnl  := greatest(v_pnl, -v_pos.margin);
  v_fee  := v_pos.margin + v_pnl; -- remaining maintenance margin, forfeited

  insert into public.orders (user_id, symbol, side, type, qty, leverage, status, fill_price, filled_at, fee, cancel_reason, created_at)
    values (v_pos.user_id, v_pos.symbol, v_side, 'liquidation', v_pos.qty, v_pos.leverage, 'filled', v_price, v_ts, v_fee, null, v_ts)
    returning id into v_order;

  insert into public.fills (user_id, order_id, position_id, symbol, side, qty, price, realized_pnl, fee, created_at)
    values (v_pos.user_id, v_order, v_pos.id, v_pos.symbol, v_side, v_pos.qty, v_price, v_pnl, v_fee, v_ts);

  update public.positions set
    avg_exit     = (coalesce(avg_exit, 0) * closed_qty + v_price * qty) / (closed_qty + qty),
    closed_qty   = closed_qty + qty,
    qty          = 0,
    margin       = 0,
    realized_pnl = realized_pnl + v_pnl,
    fees         = fees + v_fee,
    status       = 'closed',
    closed_at    = v_ts,
    close_reason = 'liquidated',
    last_fill_at = v_ts
  where id = v_pos.id
  returning * into v_pos;

  return v_pos;
end $$;

create or replace function public.adjust_balance(p_amount numeric, p_note text default null)
returns public.accounts language plpgsql security invoker set search_path = public as $$
declare v_acc public.accounts;
begin
  if p_amount is null or p_amount = 0 then raise exception 'invalid amount'; end if;
  select * into v_acc from public.accounts where user_id = auth.uid() for update;
  if not found then raise exception 'account not found'; end if;
  if v_acc.balance + p_amount < 0 then raise exception 'insufficient balance'; end if;

  update public.accounts set balance = balance + p_amount
    where user_id = auth.uid() returning * into v_acc;
  insert into public.balance_adjustments (user_id, amount, note, balance_after)
    values (auth.uid(), p_amount, nullif(trim(p_note), ''), v_acc.balance);
  return v_acc;
end $$;

-- ───────────────────────────── Storage (journal screenshots) ─────────────────────────────

insert into storage.buckets (id, name, public)
  values ('journal', 'journal', false)
  on conflict (id) do nothing;

drop policy if exists "journal own select" on storage.objects;
drop policy if exists "journal own insert" on storage.objects;
drop policy if exists "journal own delete" on storage.objects;

create policy "journal own select" on storage.objects for select to authenticated
  using (bucket_id = 'journal' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "journal own insert" on storage.objects for insert to authenticated
  with check (bucket_id = 'journal' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "journal own delete" on storage.objects for delete to authenticated
  using (bucket_id = 'journal' and (storage.foldername(name))[1] = auth.uid()::text);

-- Make PostgREST pick up the new function signatures immediately.
notify pgrst, 'reload schema';
