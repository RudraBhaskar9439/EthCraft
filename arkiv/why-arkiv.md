# Why Arkiv

The demonstrated property is independently queryable, expiring coordination data. A player or compatible client reads the publisher-owned progress entities directly from the DB-chain without needing EthCraft's database credentials or a running EthCraft HTTP API. The same entity links a source worker's observed progress to the target worker's stage.

Postgres can serve public data through an API. If this feature used only the project's private Postgres, however, other clients would depend on the operator maintaining that API, its query interface and its access rules. Arkiv supplies the shared query and ownership/expiry model directly. That changes a visible feature: the task board and handoff path read those records from Arkiv instead of treating them as an unused log.

Arkiv does not make Minecraft observations independently true or the server decentralized. This implementation has one trusted runtime publisher. A compromised publisher could lie or delete its records. Game state, identities, wallet delegation, exact payment receipts and unknown physical effects therefore remain authoritative locally and are rechecked before execution. The shared data never imports execution or spending authority.

Expiring records bound coordination data lifetime, not secrecy. Prompts, private reasoning and identifiers are excluded before publication. Permanent reputation and credit scoring are intentionally absent because finite, owner-controlled runtime reports do not justify those claims.
