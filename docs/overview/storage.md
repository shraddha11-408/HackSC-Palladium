# Incident storage

Palladium uses the Runpod disk as its working media store and SQLite as its live index. Phone frames enter a short RAM buffer; it does not archive a continuous live feed. A temporal trigger or reviewer bookmark saves an original pre/post window locally. Full uploaded input files and generated review copies remain on Runpod.

When `SUPABASE_URL` and `SUPABASE_SECRET_KEY` are configured on the backend, a separate CPU/network worker automatically archives each incident's original MP4, thumbnail and versioned JSON manifest in the **private** `safesc-incidents` Supabase Storage bucket. The manifest includes incident details, model provenance, uncertainty and append-only reviewer history. This is an object archive, not a migration of the live SQLite database to Supabase Postgres. A restore command rebuilds the working index from the manifests.

```text
Phone -> Replit HTTPS gateway -> Runpod intake -> rolling original buffer
                                           |                 |
                                     live preview     trigger / bookmark
                                           |                 |
                                      dashboard       local incident window
                                                             |
                                          independent archive worker (no GPU)
                                                             |
                               private Supabase Storage: hashed original
                                    + thumbnail + versioned review manifest
                                                             |
                             800 MiB cap -> FIFO removal of oldest cloud media
                                            summaries/history remain
```

Supabase Free currently includes 1 GB of object storage and caps each file at 50 MB. Palladium defaults to an **800 MiB managed-bucket cap**, leaving headroom. Before uploading new media it removes the oldest archived incident media by original capture time when necessary. It writes an eviction manifest first, preserves the latest summary/history, and marks the archive state `evicted`. Metadata updates never re-upload evicted videos. FIFO affects only the managed bucket; any remaining local copy follows local retention. Other Supabase projects/buckets are not cleaned by this worker. If metadata alone fills the cap, or a single original exceeds the conservative 49 MiB upload limit, the worker reports a retryable failure and keeps the original locally rather than recompressing it or claiming a backup succeeded.

The configured incident retention (48 hours on the demo deployment) also applies to cloud incident media and manifests. The worker removes expired archives while the backend is online and resumes cleanup after downtime. It is **not a provider-side lifecycle timer**: shutting down every backend also stops scheduled deletion. The restore command excludes expired records. Failed or pending archives prevent normal local-retention deletion until their state is resolved. Local disk pressure still needs operational monitoring.

Reviewers can select **Keep for recall** on an incident to place an audited retention hold. A held incident keeps its local original and review files beyond normal expiry; its private cloud original and manifest are excluded from expiry and FIFO eviction, and remain eligible for restore. For held uploads, the exact uploaded file is also copied, hash-verified, and included in the private archive when available; the incident window remains a separate artifact. The hold does not confirm an event or grant training permission. Releasing it resumes the normal policy based on the original capture date, so an already old incident can expire on the next cleanup pass. Media already deleted cannot be recovered by adding a hold.

The archive cap still applies. Held media consume that capacity; if unheld media cannot free enough space, new archives report failure and stay local. A hold is not a claim that cloud backup has completed: check the archive state for **synced**. It also cannot protect against account deletion, provider loss, or manual removal of files. Derived review videos remain local and are not included in the cloud archive.

Use **Privacy & controls → Incident storage** or authenticated `GET /api/storage` to inspect usage, cap and archive failures. Incident detail includes archive state in processing/provenance. The secret key stays in backend environment configuration; the Replit UI and browser do not receive either Supabase key. Public object reads are disabled. Palladium authenticates video reads through its backend.

Original objects have SHA-256 names, are uploaded without upsert, and are downloaded once to verify their exact bytes before the archive is marked synced. Changed review metadata produces a new immutable manifest; a small `index/` pointer identifies its latest version. Original local files are never replaced by enhancement or storage compression. Generated RelayVSR/BVI/ReLift videos are intentionally excluded from the free archive and can be regenerated where inputs/checkpoints remain available.

To recover a replacement backend, configure the same project/bucket credentials and run:

```bash
uv run python -m scripts.restore_archive
```

This restores unexpired and held originals/thumbnails and reviewer records into the configured `DATA_DIR`. It verifies media hashes and refuses to replace different existing files or overwrite an existing incident's human decision. Reconnect the replacement backend to the UI afterward; Supabase Storage alone does not run the API or GPU models.

Validation on November 14, 2026: the actual existing engineering sample archived successfully using **2,957,916 bytes**. An isolated temporary index restored one incident, three review records and an identical original SHA-256. FIFO, tamper rejection and restore behavior are tested with an in-memory storage service; no real incident was deleted to fill the bucket for testing.

Sources: [Supabase Free pricing](https://supabase.com/pricing), [file limits](https://supabase.com/docs/guides/storage/uploads/file-limits), [private buckets](https://supabase.com/docs/guides/storage/buckets/fundamentals).
