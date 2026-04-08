# Deprecated — do not add new runtime art here

This tree remains **on disk** for license/source tracking and backward compatibility during migration.

**Primary runtime location:** under `assets/` (see `tools/safe_attached_migration/pathMapper.mjs` for the OLD ? NEW layout).

**Process:** run `npm run migrate-attached:mapping` and `npm run migrate-attached:dry-run` before copying or updating references. Do not delete this folder until migration is verified and references no longer point here.
