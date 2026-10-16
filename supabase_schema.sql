-- PRODOTTI (catalogo)
create table if not exists public.spesa_products (
  id          text primary key,
  user_id     uuid not null references auth.users (id) on delete cascade,
  name        text,
  name_lower  text,
  recurring   boolean default false,
  created_at  timestamptz,
  updated_at  timestamptz not null default now(),
  deleted     boolean not null default false
);

-- VOCI LISTA SPESA
create table if not exists public.spesa_list (
  id          text primary key,
  user_id     uuid not null references auth.users (id) on delete cascade,
  product_id  text,
  qty_value   double precision,
  qty_unit    text,
  bought      boolean default false,
  sort_order  double precision,          -- posizione manuale nella lista (ordinamento condiviso)
  created_at  timestamptz,
  updated_at  timestamptz not null default now(),
  deleted     boolean not null default false
);

-- Se la tabella spesa_list ESISTE GIA' (creata prima di questa colonna), lancia
-- SOLO questa riga per aggiungere il campo ordinamento senza ricreare la tabella:
--   alter table public.spesa_list add column if not exists sort_order double precision;

-- VOCI DISPENSA (frigo/dispensa)
create table if not exists public.spesa_pantry (
  id          text primary key,
  user_id     uuid not null references auth.users (id) on delete cascade,
  product_id  text,
  location    text,                 -- 'frigo' | 'dispensa'
  qty_value   double precision,     -- legacy: non più fonte di verità (vedi batches)
  qty_unit    text,                 -- legacy
  expiry      text,                 -- legacy: data ISO 'YYYY-MM-DD' o null
  batches     jsonb,                -- lista di lotti [{qty_value, qty_unit, expiry}] (autoritativa)
  created_at  timestamptz,
  updated_at  timestamptz not null default now(),
  deleted     boolean not null default false
);

-- Se la tabella spesa_pantry ESISTE GIA' (creata prima dei lotti), lancia
-- SOLO questa riga per aggiungere il campo lotti senza ricreare la tabella:
--   alter table public.spesa_pantry add column if not exists batches jsonb;

-- VOCI LISTA DESIDERI
create table if not exists public.spesa_wishlist (
  id          text primary key,
  user_id     uuid not null references auth.users (id) on delete cascade,
  product_id  text,
  created_at  timestamptz,
  updated_at  timestamptz not null default now(),
  deleted     boolean not null default false
);

-- Indici per il pull incrementale (per utente, ordinato per updated_at)
create index if not exists spesa_products_user_updated on public.spesa_products (user_id, updated_at);
create index if not exists spesa_list_user_updated     on public.spesa_list     (user_id, updated_at);
create index if not exists spesa_pantry_user_updated   on public.spesa_pantry   (user_id, updated_at);
create index if not exists spesa_wishlist_user_updated on public.spesa_wishlist (user_id, updated_at);

-- RLS
alter table public.spesa_products enable row level security;
alter table public.spesa_list     enable row level security;
alter table public.spesa_pantry   enable row level security;
alter table public.spesa_wishlist enable row level security;

-- Policy spesa_products
create policy "spesa_products_select_own" on public.spesa_products for select using (auth.uid() = user_id);
create policy "spesa_products_insert_own" on public.spesa_products for insert with check (auth.uid() = user_id);
create policy "spesa_products_update_own" on public.spesa_products for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "spesa_products_delete_own" on public.spesa_products for delete using (auth.uid() = user_id);

-- Policy spesa_list
create policy "spesa_list_select_own" on public.spesa_list for select using (auth.uid() = user_id);
create policy "spesa_list_insert_own" on public.spesa_list for insert with check (auth.uid() = user_id);
create policy "spesa_list_update_own" on public.spesa_list for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "spesa_list_delete_own" on public.spesa_list for delete using (auth.uid() = user_id);

-- Policy spesa_pantry
create policy "spesa_pantry_select_own" on public.spesa_pantry for select using (auth.uid() = user_id);
create policy "spesa_pantry_insert_own" on public.spesa_pantry for insert with check (auth.uid() = user_id);
create policy "spesa_pantry_update_own" on public.spesa_pantry for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "spesa_pantry_delete_own" on public.spesa_pantry for delete using (auth.uid() = user_id);

-- Policy spesa_wishlist
create policy "spesa_wishlist_select_own" on public.spesa_wishlist for select using (auth.uid() = user_id);
create policy "spesa_wishlist_insert_own" on public.spesa_wishlist for insert with check (auth.uid() = user_id);
create policy "spesa_wishlist_update_own" on public.spesa_wishlist for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "spesa_wishlist_delete_own" on public.spesa_wishlist for delete using (auth.uid() = user_id);
