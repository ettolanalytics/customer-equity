-- Customer Equity · migratie 14
-- publication_v2.horizon_discount_factor = 1 ÷ (1 + disconto)^(horizon in jaren): wat €1 aan het
-- eind van de horizon vandaag waard is (bij 10% en 5 jaar: €0,62). Voor de tekst "Future margin in
-- today's euros" in Model and assumptions; de app rekent niets.

alter table ce_public.publication_v2 add column horizon_discount_factor double precision
  check (horizon_discount_factor > 0 and horizon_discount_factor <= 1);

create or replace function ce_private.publish_v2()
returns text
language plpgsql security definer set search_path = ''
as $$
declare
  v_started timestamptz := clock_timestamp();
  v_fail    jsonb;
  v_n       integer;
  v_msg     text;
  v_detail  text;
begin
  begin
    set local statement_timeout = '10min';
    set local max_parallel_workers_per_gather = 0;  -- vaste volgorde van optellen
    refresh materialized view ce_private.mv_bz_plan_money;
    refresh materialized view ce_private.mv_bz_margin_path;
    refresh materialized view ce_private.mv_bz_derl;
    refresh materialized view ce_private.mv_bz_vgrid;
    refresh materialized view ce_private.mv_bz_wf_rows;
    refresh materialized view ce_private.mv_bz_quarters;
    refresh materialized view ce_private.mv_bz_quarters_json;

    select jsonb_agg(to_jsonb(c)) into v_fail from ce_private.publication_checks_v2 c;
    if v_fail is not null then
      raise exception 'v2-controles mislukt (%)', jsonb_array_length(v_fail) using detail = v_fail::text;
    end if;

    delete from ce_public.quarters_v2;
    insert into ce_public.quarters_v2 (seq, label, data)
    select seq, label, data from ce_private.mv_bz_quarters_json order by seq;
    get diagnostics v_n = row_count;

    delete from ce_public.publication_v2;
    insert into ce_public.publication_v2
      (id, generated_at, as_of, load_id, params_run_id, discount_rate_year, horizon_months, grace_days,
       first_selectable, last_quarter, quarter_count, plans, content_md5, horizon_discount_factor)
    select 1, now(),
           (select as_of from ce_private.loads where status = 'complete' order by load_id desc limit 1),
           (select max(load_id) from ce_private.loads where status = 'complete'),
           (select max(run_id) from ce_private.sbg_runs where status = 'complete'),
           s.discount_rate_year, s.horizon_months, s.grace_days,
           (select label from ce_private.mv_bz_quarters_json
             where jsonb_typeof(data -> 'waterfall') = 'object' and jsonb_typeof(data -> 'yearWaterfall') = 'object'
             order by seq limit 1),
           (select label from ce_private.mv_bz_quarters_json order by seq desc limit 1),
           v_n,
           (select jsonb_agg(jsonb_build_object('planId', p.plan_id, 'sizeGrams', p.size_grams,
                     'priceExclVatCents', p.price_excl_vat_cents, 'costCents', c.cost_cents) order by p.size_grams)
              from ce_private.bz_plans p
              join ce_private.bz_product_costs c on c.plan_id = p.plan_id and c.valid_to is null
             where p.valid_to is null),
           (select md5(string_agg(seq || label || data::text, '|' order by seq)) from ce_public.quarters_v2),
           power(1 + s.discount_rate_year, -s.horizon_months / 12.0)
    from ce_private.settings_v2 s;

    insert into ce_private.refresh_log (started_at, status, message)
    values (v_started, 'published', format('v2: %s kwartalen gepubliceerd in ce_public.quarters_v2', v_n));
    return 'published';
  exception when others then
    get stacked diagnostics v_msg = message_text, v_detail = pg_exception_detail;
    insert into ce_private.refresh_log (started_at, status, message, details)
    values (v_started, 'failed', 'v2: ' || v_msg,
            case when v_detail like '[%' then v_detail::jsonb
                 when v_detail <> '' then to_jsonb(v_detail) end);
    return 'failed: ' || v_msg;
  end;
end
$$;

revoke all on function ce_private.publish_v2() from public, anon, authenticated, service_role;
grant execute on function ce_private.publish_v2() to ce_loader;
