# Public campus activity data

The [November 14, 2026 snapshot](2026-11-14/manifest.json) contains the complete
**75,686-report** minimized historical dataset used by Palladium, with occurrence
dates January 1, 2010 through October 31, 2026 inside the published UPC Lyft-zone
approximation. It also contains every selected source page referenced by the
import manifest, OSM street geometry and attribution, pedestrian-survey evidence,
forecast evaluation, and the preloaded UI analysis bundle.

Large JSON/SQLite files are losslessly gzip-compressed. Checksums cover both the
stored and restored bytes. This directory is an explicit public-data allowlist;
the private working `data/` directory remains ignored.

Restore a checkout for local development or the Runpod data host:

```sh
python3 -m scripts.data.activity_snapshot restore
```

The restore verifies all hashes before writing, preserves identical existing
files, and refuses to overwrite different data. To inspect a snapshot separately:

```sh
python3 -m scripts.data.activity_snapshot restore --data /tmp/safesc-public-activity
```

No credentials, private incident footage, learning assets, application database,
or provider account records are included. LAPD data is public reported history,
not a finding of guilt or an individual's harm probability. Approximate locations,
reporting delays, source-system transitions, and sparse observations limit
interpretation. See [source methodology](../../docs/overview/activity-data.md)
and [forecast validation](../../docs/overview/activity-forecasting.md).

Original data sources and their terms continue to apply. OSM geometry is
© OpenStreetMap contributors under ODbL; retain [attribution and license](https://www.openstreetmap.org/copyright).
Satellite/aerial imagery is provided online by the attributed map service;
imagery tiles are not redistributed in this snapshot.
