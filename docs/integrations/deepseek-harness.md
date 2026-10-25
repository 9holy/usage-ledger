# DeepSeek Harness usage source

Official project: https://github.com/deepseek-ai/deepseek-harness (not a similarly named third-party wrapper).
Contract inspected at upstream commit `22ddee3792402c3e70ec5f86a63c3e3e895a2f60`.

## Discovery and privacy

The desktop monitor reads `$DSH_HOME/sessions`, or `~/.dsh/sessions` when `DSH_HOME` is unset. Set the environment before launching Usage Ledger if Harness uses a custom home. Canonical `session.jsonl`, `session.vN.jsonl`, and `.zstd` variants are discovered; legacy flat session files are also detected so unsupported versions produce a visible error. The highest generation in each session directory wins; mixed encodings at that generation are reported as an error rather than counted twice. Symlinks are not followed. No credentials, API keys or network session endpoints are read. Nothing is written to Harness's home.

Upstream defaults to concatenated Zstandard frames. Both that encoding and explicit `compression: none` are supported. Formats v2–v4 are supported; v0/v1 and future versions are surfaced as unsupported, not silently treated as zero usage. Nonstandard plugin storage roots and alternative persistence providers are not auto-discovered.

Changed files are hashed and projected from a streaming decoder; only metadata and final usage samples are retained. SQLite stores the projection and source fingerprint transactionally. Repeated scans/restarts do not duplicate requests. The design preserves historical ledger records when upstream files disappear. Corrupt or incomplete compressed data fails the scan without committing partial state and is retried by normal watcher/reconciliation. An unfinished plaintext tail also defers the snapshot until the next append, preserving previously committed history. Concurrent changes between fingerprinting and decoding defer the scan. A complete rewritten/migrated snapshot reconciles superseded requests without retaining permanent aliases.

## Accounting

- Durable `assistant/message` usage takes precedence over the final embedded usage stream sample. `assistant/attempt` uses its final embedded sample.
- `inputTokens` is **uncached** input. Ledger prompt input is uncached + cache read + cache write (or an exact validated `totalTokens - outputTokens` when available).
- Reasoning is a subset of output, never an extra billed output bucket.
- Missing cache buckets remain unknown, never fabricated as confirmed zero.
- Repeated settlements for the same turn/step/attempt replace the prior sample. A `llm/retry-started` boundary makes a new billable attempt.
- The last inherited `session/end-seed` boundary excludes copied fork history. Child usage remains linked to its parent session.
- Provider route and response model are preserved. A route such as `deepseek-official` can itself point at a custom gateway; it is not proof of billing provider. Existing catalog pricing remains a clearly evidenced reference estimate, not an actual paid amount. No new hard-coded prices are introduced.

## Upstream references

- `packages/bundle/base/cordis.patch.yml`: default sessions root.
- `packages/session/session-persistence-jsonl/src/{index,format,generation}.ts`: framing, compression and generations.
- `packages/llm/token-meter/src/{usage-projection,turn-usage}.ts`: disjoint tokens and retry semantics.
- `packages/llm/llm-deepseek/README.md`: configurable routes and gateways.

Tests use synthetic contract fixtures, not the user's installed client, private histories or API credentials. Cloud tests cannot certify Windows watcher behavior or an actual desktop installation.
