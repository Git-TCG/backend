-- External uptime probes (GitHub Actions every 5 minutes). Missing buckets count as downtime.
CREATE TABLE uptime_probes (
  checked_at timestamptz PRIMARY KEY,
  ok boolean NOT NULL
);
