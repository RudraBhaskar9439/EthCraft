# South Mumbai on the laptop server

The Mumbai world covers roughly 8.5 square kilometres around Gateway of India,
Fort/CST, Nariman Point and southern Marine Drive. It uses real street, building,
coast, terrain and tree data through the free official Arnis 3.4.0 generator.
Architecture and stadium models are generated approximations. This is a South
Mumbai district, not a handcrafted, complete or exact replica of Mumbai.

The [generator profile](../config/mumbai-map.json) records the area, pinned
download/checksum and source credits. The original generation used the October 25,
2026 OSM tile archive and available Mapterhorn elevation; finer elevation tiles
were unavailable, so Arnis used coarser parent tiles. No paid API was used.

## Visit

Use the existing approved Minecraft profile on `127.0.0.1:25596`:

```text
/mumbai
/lobby
```

The Guide menu also has **Visit South Mumbai**. `/lobby` returns to AgentCity.
The existing local approval requirement still applies; the map does not verify
an account, wallet or independent human participant.

Mumbai is an Adventure sightseeing area with clear morning weather, eight-chunk
view distance and two-chunk simulation distance. You keep your inventory. Block
changes, container access, item extraction, damage and inventory drops are
blocked. Flight is not granted. The marketplace, agent task regions, estates and
calculator museum remain in their original worlds. Do not use generated Mumbai
blocks as material stock, collateral, property ownership or token backing.

## Files and operations

- Prepared world: `.local/mumbai/artifact/agentcity_mumbai`.
- Exact artifact hashes and operational world UUID/spawn: `.local/mumbai/artifact-manifest.json`.
- Runtime config: `.local/mumbai/mumbai-world.json`, copied into `plugins/AgentCity` on installation.
- Generated world and original preview: `.local/mumbai/generation`.
- Isolated import: `.local/mumbai/isolated`; its active descriptor is `isolated-active.json`.
- Native and database backups: `.local/mumbai/backups` and the backup path recorded there.

The world is about 147 MB; it and the downloaded generator stay out of Git.
Regeneration downloads are hash-checked against the official release:

```sh
python3 scripts/mumbai_map.py fetch
python3 scripts/mumbai_map.py generate
python3 scripts/mumbai_map.py status
```

Generation reuses an existing completed local run. A newly generated world still
needs its own prepared artifact, UUID, calibrated safe arrival and isolated proof;
do not overwrite an installed city with a new download or reuse old proof.

For the prepared artifact on this laptop:

```sh
python3 scripts/mumbai_host.py isolate
node tests/maps/mumbai-visit.mjs
python3 scripts/mumbai_host.py install
node tests/maps/mumbai-visit.mjs --active
python3 scripts/mumbai_host.py cleanup
```

These are controlled operator checks, not human acceptance. `isolate` briefly
stops the owned live host for a consistent copy, then resumes it before testing.
`install` requires matching actual proof, takes native/PostgreSQL backups and
preserves the existing namespace and every old dimension UUID. A failed rollout
archives only the owned imported world and restores the previous plugin/profile.
It never rolls back PostgreSQL or a live chain. Do not repeat `install` over an
existing imported city. Existing isolated copies are retained for diagnosis.

The pinned Paper 26.3 server migrates legacy Java world folders into the primary
world's `dimensions/minecraft` storage. Its persisted UUIDs are in
`data/paper/metadata.dat`, not top-level `uid.dat`. The loader and rollout checks
support that layout and refuse missing/ambiguous identities or empty regions.
Arnis' suggested spawn was two blocks above the pavement; the tested import uses
the actual pavement height. Both initial isolated failures remain recorded.

Image-map signage, photo facades and starter maps were disabled. Two unused
generated atlas/counter files were excluded from the import to avoid cross-world
map-ID storage conflicts. Ordinary block facades, interiors, props and vegetation
remain. No shader, resource pack or client mod is required.

## Attribution and limits

Map data © [OpenStreetMap contributors](https://www.openstreetmap.org/copyright),
ODbL. Generated with [Arnis 3.4.0](https://github.com/louis-e/arnis/releases/tag/v3.4.0),
Apache-2.0. Additional footprints/heights: [Overture Maps](https://docs.overturemaps.org/attribution/).
Terrain: [Mapterhorn and its sources](https://mapterhorn.com/). Land cover:
[ESA WorldCover 2021](https://esa-worldcover.org/en/data-access), CC BY 4.0.
Canopy, regional trees and 3D props retain their individual upstream credits in
[Arnis' attribution list](https://github.com/louis-e/arnis/blob/v3.4.0/src/gui/js/license.js).
The generator's LICENSE, NOTICE and complete asset-credit source are retained in
`.local/mumbai/upstream-credits`; include them and this attribution when sharing
the generated world. Player entry and the Guide menu also credit the data.

The preview is an actual generator overview. It is not a screenshot of a human
Minecraft client. Native controlled-client checks establish import, walking,
permissions and inventory preservation; they do not establish complete visual
coverage of every street or original phase/production qualification.

## Verified checkpoint

The [Mumbai checkpoint](../evidence/MUMBAI_WORLD_CHECKPOINT.json) links the actual
generation, plugin, isolated visit, active visit and saved-inventory reports.
The active laptop server serves the city on `127.0.0.1:25596`; its original six
world identities and server namespace are preserved. Twelve plugin/config/storage
checks, five isolated visit checks, five active visit checks and three original
actor inventory comparisons passed.

The owned isolated test container has been removed; its runtime and reports remain
for diagnosis. Six subsequent read-only checks confirmed that the active server
was still running, Mumbai was ready, all seven identities matched and the isolated
container was gone. The 65 planning unit tests and planning consistency check also
passed. Those planning checks do not qualify product or production gates.

Initial failed spawn, migrated-storage and client-preflight attempts remain in
the checkpoint rather than being replaced by the successful runs. This map work
used no paid model calls or chain requests. Full visual/human acceptance and a
full-host restore/reboot drill remain separate work.
