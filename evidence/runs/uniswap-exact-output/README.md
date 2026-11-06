# Exact-output swap verification

[`verification.json`](verification.json) records the tested source hashes, native plugin artifact hash and local check results. The passing market run is [`55d76d95-1fd5-4f62-af81-40802b04f07f`](../playable-uniswap/55d76d95-1fd5-4f62-af81-40802b04f07f/report.json).

Verification passed four new exact-output contract tests, three original hooked exact-input tests, ten actual PostgreSQL/Anvil market checks, nine wallet/policy checks, Discord/game transport checks, the maintained plugin build, 56 Python planning tests and planning integrity. The tests used official v4 contracts and actual local token transfers. Signing identities, token funding, Privy responses and Discord clients were disclosed fixtures.

The interrupted-response check recovers the original signed swap after service recreation, receives exactly the requested CITY amount and spends no more than the original GEM ceiling. Repeating confirmation and retry creates no additional signatures or spending. A separate migration check preserves an outstanding input quote across the actual old table shape.

Earlier failures are retained. The initial fresh setup lacked the Forge output directory; block number and administrator nonce were both zero before its start marker was archived and the setup retried. The first integration run failed because its assertion expected lower-case error text, while PostgreSQL correctly returned `PLAYABLE_MARKET_PREVIEW_IMMUTABLE`.

No public transactions, paid model calls, live policy changes or Minecraft-world effects occurred. The native receive-command parser compiled; live Discord/Minecraft command acceptance and independent-human verification remain pending. These component checks do not pass canonical phase gates.
