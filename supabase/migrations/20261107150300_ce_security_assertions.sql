-- Customer Equity · migratie 5/5
-- Controleert de werkelijke rechten na migraties 1-4 en breekt de migratie af
-- (rollback) bij elke afwijking. Wijzigt zelf niets.
--
-- Gecontroleerd:
--   1. RLS staat aan op elke tabel in ce_private en ce_public.
--   2. anon, authenticated, service_role (en via anon ook PUBLIC) hebben geen toegang tot schema ce_private.
--   3. Op tabellen/views in beide schema's heeft geen van die rollen enig recht,
--      behalve anon: SELECT op ce_public.
--   4. anon heeft SELECT én een SELECT-policy op elke ce_public-tabel, en geen andere policies.
--   5. In ce_public bestaan geen functies of procedures.
--   6. ce_loader is geen superuser en heeft geen BYPASSRLS, CREATEROLE, CREATEDB of REPLICATION.
--   7. ce_loader heeft op ce_public alleen SELECT, op invoices geen UPDATE/DELETE,
--      en geen CREATE op de schema's.
--   8. Functies in ce_private: niet uitvoerbaar door anon, authenticated, service_role
--      of PUBLIC. refresh_and_publish() is SECURITY DEFINER met vaste search_path en
--      uitvoerbaar door ce_loader.

do $$
declare
  r          record;
  problems   text[] := array[]::text[];
  browser_roles constant name[] := array['anon', 'authenticated', 'service_role']::name[];
  privs      constant text[] := array['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'];
  role_name  name;
  priv       text;
begin
  -- 1. RLS
  for r in
    select n.nspname, c.relname
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname in ('ce_private', 'ce_public')
      and c.relkind in ('r', 'p')
      and not c.relrowsecurity
  loop
    problems := problems || format('RLS staat uit op %I.%I', r.nspname, r.relname);
  end loop;

  -- 2. Schema-toegang
  foreach role_name in array browser_roles loop
    if has_schema_privilege(role_name, 'ce_private', 'USAGE') then
      problems := problems || format('%s heeft USAGE op schema ce_private', role_name);
    end if;
    if has_schema_privilege(role_name, 'ce_private', 'CREATE')
       or has_schema_privilege(role_name, 'ce_public', 'CREATE') then
      problems := problems || format('%s heeft CREATE op een ce-schema', role_name);
    end if;
    if role_name <> 'anon' and has_schema_privilege(role_name, 'ce_public', 'USAGE') then
      problems := problems || format('%s heeft USAGE op schema ce_public', role_name);
    end if;
  end loop;
  if not has_schema_privilege('anon', 'ce_public', 'USAGE') then
    problems := problems || 'anon mist USAGE op schema ce_public'::text;
  end if;

  -- 3. Tabel- en viewrechten
  for r in
    select n.nspname, c.relname, c.oid
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname in ('ce_private', 'ce_public')
      and c.relkind in ('r', 'p', 'v', 'm')
  loop
    foreach role_name in array browser_roles loop
      foreach priv in array privs loop
        if has_table_privilege(role_name, r.oid, priv)
           and not (r.nspname = 'ce_public' and role_name = 'anon' and priv = 'SELECT') then
          problems := problems || format('%s heeft %s op %I.%I', role_name, priv, r.nspname, r.relname);
        end if;
      end loop;
    end loop;
  end loop;

  -- 4. anon: SELECT + SELECT-policy op elke ce_public-tabel, geen andere policies
  for r in
    select c.oid, c.relname
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'ce_public' and c.relkind in ('r', 'p')
  loop
    if not has_table_privilege('anon', r.oid, 'SELECT') then
      problems := problems || format('anon mist SELECT op ce_public.%I', r.relname);
    end if;
    if not exists (
      select 1 from pg_policies p
      where p.schemaname = 'ce_public' and p.tablename = r.relname
        and p.cmd = 'SELECT' and 'anon' = any (p.roles)
    ) then
      problems := problems || format('anon mist SELECT-policy op ce_public.%I', r.relname);
    end if;
  end loop;

  for r in
    select p.schemaname, p.tablename, p.policyname, p.cmd, p.roles
    from pg_policies p
    where p.schemaname in ('ce_private', 'ce_public')
      and (p.roles && array['anon', 'authenticated', 'service_role', 'public']::name[])
      and not (p.schemaname = 'ce_public' and p.cmd = 'SELECT' and p.roles = array['anon']::name[])
  loop
    problems := problems || format('onverwachte policy %s op %I.%I (%s voor %s)',
                                   r.policyname, r.schemaname, r.tablename, r.cmd, r.roles);
  end loop;

  -- 5. Geen functies in ce_public
  for r in
    select p.proname
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'ce_public'
  loop
    problems := problems || format('functie in ce_public: %I', r.proname);
  end loop;

  -- 6. Attributen van ce_loader
  for r in
    select rolsuper, rolbypassrls, rolcreaterole, rolcreatedb, rolreplication
    from pg_roles where rolname = 'ce_loader'
  loop
    if r.rolsuper or r.rolbypassrls or r.rolcreaterole or r.rolcreatedb or r.rolreplication then
      problems := problems || 'ce_loader heeft te ruime rolattributen'::text;
    end if;
  end loop;
  if not exists (select 1 from pg_roles where rolname = 'ce_loader') then
    problems := problems || 'rol ce_loader ontbreekt'::text;
  end if;

  -- 7. Beperkingen van ce_loader
  if has_table_privilege('ce_loader', 'ce_private.invoices', 'UPDATE')
     or has_table_privilege('ce_loader', 'ce_private.invoices', 'DELETE') then
    problems := problems || 'ce_loader kan facturen wijzigen of per rij verwijderen'::text;
  end if;
  for r in
    select c.oid, c.relname
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'ce_public' and c.relkind in ('r', 'p')
  loop
    foreach priv in array privs loop
      if priv <> 'SELECT' and has_table_privilege('ce_loader', r.oid, priv) then
        problems := problems || format('ce_loader heeft %s op ce_public.%I', priv, r.relname);
      end if;
    end loop;
  end loop;

  -- 8. Functies in ce_private
  for r in
    select p.oid, p.proname, p.prosecdef, p.proconfig
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'ce_private'
  loop
    foreach role_name in array browser_roles loop
      if has_function_privilege(role_name, r.oid, 'EXECUTE') then
        problems := problems || format('%s kan ce_private.%I uitvoeren', role_name, r.proname);
      end if;
    end loop;
    if exists (select 1 from aclexplode(coalesce((select proacl from pg_proc where oid = r.oid),
                                                 acldefault('f', (select proowner from pg_proc where oid = r.oid))))
               where grantee = 0 and privilege_type = 'EXECUTE') then
      problems := problems || format('PUBLIC kan ce_private.%I uitvoeren', r.proname);
    end if;
    if r.proname = 'refresh_and_publish' then
      if not r.prosecdef then
        problems := problems || 'refresh_and_publish is geen SECURITY DEFINER'::text;
      end if;
      if r.proconfig is null or not ('search_path=""' = any (r.proconfig)) then
        problems := problems || 'refresh_and_publish heeft geen vaste search_path'::text;
      end if;
      if not has_function_privilege('ce_loader', r.oid, 'EXECUTE') then
        problems := problems || 'ce_loader kan refresh_and_publish niet uitvoeren'::text;
      end if;
    end if;
  end loop;
  if has_schema_privilege('ce_loader', 'ce_private', 'CREATE')
     or has_schema_privilege('ce_loader', 'ce_public', 'CREATE') then
    problems := problems || 'ce_loader heeft CREATE op een ce-schema'::text;
  end if;

  if cardinality(problems) > 0 then
    raise exception E'Customer Equity beveiligingscontrole mislukt:\n- %', array_to_string(problems, E'\n- ');
  end if;

  raise notice 'Customer Equity beveiligingscontrole geslaagd.';
end
$$;
