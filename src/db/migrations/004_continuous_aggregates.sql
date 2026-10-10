-- atlas:no-transaction
-- Continuous aggregates must be created outside a transaction. materialized_only = false
-- keeps them real-time, so a just-logged expense shows up in the running total immediately.

CREATE MATERIALIZED VIEW trip_spend_daily
WITH (timescaledb.continuous, timescaledb.materialized_only = false) AS
SELECT trip_id,
       time_bucket(INTERVAL '1 day', at) AS day,
       category,
       sum(amount_cents)::bigint AS spent_cents,
       count(*) AS events
FROM spend_events
GROUP BY trip_id, time_bucket(INTERVAL '1 day', at), category
WITH NO DATA;

SELECT add_continuous_aggregate_policy('trip_spend_daily',
  start_offset => INTERVAL '90 days', end_offset => INTERVAL '1 hour', schedule_interval => INTERVAL '30 minutes');

CREATE MATERIALIZED VIEW forecast_drift_daily
WITH (timescaledb.continuous, timescaledb.materialized_only = false) AS
SELECT trip_id,
       day,
       time_bucket(INTERVAL '1 day', fetched_at) AS fetched_day,
       min(precip_probability) AS precip_min,
       max(precip_probability) AS precip_max,
       min(temp_max_f) AS tmax_min,
       max(temp_max_f) AS tmax_max,
       count(*) AS fetches
FROM weather_snapshots
GROUP BY trip_id, day, time_bucket(INTERVAL '1 day', fetched_at)
WITH NO DATA;

SELECT add_continuous_aggregate_policy('forecast_drift_daily',
  start_offset => INTERVAL '30 days', end_offset => INTERVAL '1 hour', schedule_interval => INTERVAL '1 hour');
