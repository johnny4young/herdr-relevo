# Local metadata snapshot

This mode imports persisted metadata, not live activity or terminal output. It never attaches to the original core. It does not copy account settings, commands, environment, labels, screens, transcripts, credentials or tokens. Titles and workspace names are local metadata; they remain only on this computer. Goals, owners and acceptance criteria remain unknown.

Source: two explicitly permitted JSON files in the user's herdr-core/default state directory. The extractor writes only under `/private/tmp/herdr-relevo-snapshot-<uid>`, with network/fork denied and execution restricted to the selected Node.js runtime. The runtime cannot read the source files. Source hashes and mtimes are checked before/after extraction; verification is retained locally.

The plugin code comes from this development checkout, not a claim of exact installed-plugin version parity. A hash manifest records copied files.

Run `scripts/snapshot-herdr.sh setup`, then `preflight`, `check`, `run`. In another shell use `seed`, `status` or `shot`. No GUI opens during setup. `seed` requires an empty isolated core and creates native shell copies using a fixed harmless viewer, passing copied text as data arguments. Copied statuses are historical metadata, not fabricated live agent statuses. Mapping records link original IDs to new isolated terminal IDs. Empty/mod-only tabs become an explicitly labeled metadata viewer.

`stop` addresses only the dedicated snapshot app/core sockets. `refresh` refuses an active app/core, archives the entire previous scratch tree without deletion, then extracts again. Stop the snapshot first. The separate synthetic preview is not changed.

Tests: run `node --test 'scripts/tests/*.test.mjs'`. Never upload the extracted metadata or screenshots without explicit permission.

Reopen an existing snapshot with `run` only. `setup` refuses an already prepared snapshot even after its window closes; it never resets it. `refresh` is the explicit archive-and-reimport operation. Native split copies preserve leaf count and mapping but use right-hand splits, not exact original geometry. Three reported-provenance copies may appear as idle `relevo-snapshot` viewers; this is the copy’s state, never the source agent’s live state.

Text hardening: common credential-shaped strings in permitted metadata are replaced entirely with `Contenido sensible omitido` before truncation. This is a conservative heuristic, not a guarantee against arbitrary secrets placed in titles. Raw credential fields are never imported. Raw cwd is reduced to its basename, but a terminal title can itself contain a displayed path; titles are not claimed to be path-free.

The launchers use Bash and Node.js (no additional packages). For a snapshot prepared by an older launcher, stop that isolated snapshot and use `refresh` to archive and migrate it. The active Herdr session is separate.

Run `preflight` and synthetic `seed` from an interactive terminal: the native PTY probe inherits its terminal input. A noninteractive pipe does not supply terminal attributes and fails the probe.
