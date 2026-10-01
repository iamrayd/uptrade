-- UpTrade schema. Run once in Supabase → SQL Editor (safe to re-run).
-- Single-user paper trading: netted positions per symbol, 100% margin, no fees.

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
  realized_pnl  numeric(24,8) not null default 0,
  status        text not null default 'open' check (status in ('open', 'closed')),
  opened_at     timestamptz not null default now(),
  closed_at     timestamptz,
  check (status = 'closed' or qty > 0)
);
create unique index if not exists positions_one_open_per_symbol
  on public.positions (user_id, symbol) where status = 'open';
create index if not exists positions_history_idx
  on public.positions (user_id, status, closed_at desc);

create table if not exists public.orders (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null default auth.uid() references auth.users on delete cascade,
  symbol         text not null,
  side           text not null check (side in ('buy', 'sell')),
  type           text not null check (type in ('market', 'limit')),
  qty            numeric(28,10) not null check (qty > 0),
  limit_price    numeric(28,10) check (limit_price is null or limit_price > 0),
  status         text not null default 'open' check (status in ('open', 'filled', 'cancelled')),
  fill_price     numeric(28,10),
  cancel_reason  text,
  created_at     timestamptz not null default now(),
  filled_at      timestamptz
);
create index if not exists orders_status_idx on public.orders (user_id, status);

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
create index if not exists fills_position_idx on public.fills (position_id, created_at);

create table if not exists public.journal_entries (
  position_id  uuid primary key references public.positions on delete cascade,
  user_id      uuid not null default auth.uid() references auth.users on delete cascade,
  notes        text not null default '',
  tags         text[] not null default '{}',
  rating       smallint check (rating between 1 and 5),
  screenshots  text[] not null default '{}',
  updated_at   timestamptz not null default now()
);

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

-- Applies one fill of p_order at p_price. Nets against an opposite position
-- first (realizing PnL), then opens/adds with whatever quantity remains.
create or replace function public._apply_fill(p_order public.orders, p_price numeric, p_ts timestamptz)
returns void language plpgsql security invoker set search_path = public as $$
declare
  v_uid        uuid := p_order.user_id;
  v_dir        text := case when p_order.side = 'buy' then 'long' else 'short' end;
  v_bal        numeric;
  v_pos        public.positions;
  v_has_pos    boolean;
  v_same_id    uuid;
  v_remaining  numeric := p_order.qty;
  v_close      numeric;
  v_pnl        numeric;
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
    v_close := least(v_remaining, v_pos.qty);
    v_pnl := case when v_pos.side = 'long'
                  then (p_price - v_pos.avg_entry) * v_close
                  else (v_pos.avg_entry - p_price) * v_close end;
    v_bal := v_bal + v_close * v_pos.avg_entry + v_pnl;

    update public.positions set
      avg_exit     = (coalesce(avg_exit, 0) * closed_qty + p_price * v_close) / (closed_qty + v_close),
      closed_qty   = closed_qty + v_close,
      qty          = qty - v_close,
      realized_pnl = realized_pnl + v_pnl,
      status       = case when qty - v_close = 0 then 'closed' else 'open' end,
      closed_at    = case when qty - v_close = 0 then p_ts else null end
    where id = v_pos.id;

    insert into public.fills (user_id, order_id, position_id, symbol, side, qty, price, realized_pnl, created_at)
      values (v_uid, p_order.id, v_pos.id, p_order.symbol, p_order.side, v_close, p_price, v_pnl, p_ts);

    v_remaining := v_remaining - v_close;
  elsif v_has_pos then
    v_same_id := v_pos.id;
  end if;

  -- 2) Open / add with the remainder.
  if v_remaining > 0 then
    if v_bal < v_remaining * p_price then
      raise exception 'insufficient balance';
    end if;
    v_bal := v_bal - v_remaining * p_price;

    if v_same_id is not null then
      update public.positions set
        avg_entry = (avg_entry * qty + p_price * v_remaining) / (qty + v_remaining),
        qty       = qty + v_remaining,
        entry_qty = entry_qty + v_remaining
      where id = v_same_id;
      v_new_id := v_same_id;
    else
      insert into public.positions (user_id, symbol, side, qty, entry_qty, avg_entry, opened_at)
        values (v_uid, p_order.symbol, v_dir, v_remaining, v_remaining, p_price, p_ts)
        returning id into v_new_id;
    end if;

    insert into public.fills (user_id, order_id, position_id, symbol, side, qty, price, realized_pnl, created_at)
      values (v_uid, p_order.id, v_new_id, p_order.symbol, p_order.side, v_remaining, p_price, 0, p_ts);
  end if;

  if v_bal < 0 then raise exception 'insufficient balance'; end if;
  update public.accounts set balance = v_bal where user_id = v_uid;

  update public.orders set status = 'filled', fill_price = p_price, filled_at = p_ts
    where id = p_order.id;
end $$;

create or replace function public.place_order(
  p_symbol text, p_side text, p_type text, p_qty numeric,
  p_limit_price numeric default null, p_market_price numeric default null)
returns public.orders language plpgsql security invoker set search_path = public as $$
declare v_order public.orders;
begin
  if auth.uid() is null then raise exception 'not authenticated'; end if;
  if p_qty is null or p_qty <= 0 then raise exception 'invalid quantity'; end if;
  if p_side not in ('buy', 'sell') then raise exception 'invalid side'; end if;

  if p_type = 'market' then
    if p_market_price is null or p_market_price <= 0 then raise exception 'invalid price'; end if;
    insert into public.orders (user_id, symbol, side, type, qty)
      values (auth.uid(), upper(p_symbol), p_side, 'market', p_qty)
      returning * into v_order;
    perform public._apply_fill(v_order, p_market_price, now());
    select * into v_order from public.orders where id = v_order.id;
  elsif p_type = 'limit' then
    if p_limit_price is null or p_limit_price <= 0 then raise exception 'invalid price'; end if;
    insert into public.orders (user_id, symbol, side, type, qty, limit_price)
      values (auth.uid(), upper(p_symbol), p_side, 'limit', p_qty, p_limit_price)
      returning * into v_order;
  else
    raise exception 'invalid order type';
  end if;
  return v_order;
end $$;

-- Fills an open limit order at its limit price. No-op if already filled/cancelled,
-- so racing tabs/devices can't double-fill. A fill that fails (e.g. not enough
-- balance) cancels the order with the reason instead of erroring.
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
      greatest(coalesce(p_filled_at, now()), v_order.created_at));
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
    'market', v_pos.qty, null, p_market_price);
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
