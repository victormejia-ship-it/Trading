-- Tabla única: una fila por (fecha, ticker). ticker='_MERCADO' guarda el semáforo.
create table if not exists public.analisis_diario (
  fecha       date        not null,
  ticker      text        not null,
  tipo        text        not null check (tipo in ('MERCADO','ACTIVO')),
  payload     jsonb       not null,
  creado_en   timestamptz not null default now(),
  primary key (fecha, ticker)
);
create index if not exists analisis_diario_fecha_idx on public.analisis_diario (fecha desc);

-- App privada: solo usuarios autenticados leen; solo el worker (service_role, salta RLS) escribe.
alter table public.analisis_diario enable row level security;

drop policy if exists "lectura_autenticados" on public.analisis_diario;
create policy "lectura_autenticados" on public.analisis_diario
  for select to authenticated using (true);
-- Para restringir a tu usuario: using (auth.jwt() ->> 'email' = 'tu-correo@dominio.com')
