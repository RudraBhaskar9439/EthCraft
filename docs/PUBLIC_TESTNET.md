# Public testnet contract demonstration

This deployment is the separate synthetic contract demonstration approved by the user. Token ownership, purchases and payments have no effect on Minecraft. Ollama is the temporary inference provider, and the laptop is the private host. No real-money spending is authorized.

## Deployed networks

- Settlement: Unichain Sepolia, chain 1301, official RPC `https://sepolia.unichain.org`.
- Discovery: Arkiv Tiramisu, chain 7738577, official RPC `https://rpc.tiramisu.db-chain.testnet.arkiv.network`.
- Public contract addresses and pinned official deployment code hashes are recorded in [the deployment manifest](../contracts/public-testnet-deployment.json).
- Uniswap PoolManager, PositionManager and Permit2 are official existing deployments. AgentCity did not deploy a replacement AMM or publish upstream test-router code.

| Component | Public testnet address |
| --- | --- |
| CRED test token | `0xb7f284315c88fed7e8bf3a0a1208fe8afc35abcd` |
| KIT synthetic claims | `0xda2ec869cc3d95e75ef6b48edb34e965e0980dd5` |
| State publisher registry | `0xf035f2570dc6cb85fbcc1449e1455e128043d5f5` |
| Swap hook | `0xAaf77897b884B593A9c2a085A411C6495119C080` |
| Bounded procurement | `0xfd48750b087e441b9fabb3f19e828a4aa6d005c2` |
| Labor escrow | `0x29a1b8f2408ba8fc7bef17d1d75f10a133328d01` |
| Official PoolManager | `0x9cB26A7183B2F4515945Dc52CB4195B0d2D06C95` |

## Operate the pilot

Run from the repository root:

```sh
python3 scripts/local_host.py start
python3 scripts/local_host.py status
node scripts/public_testnet_verify.mjs
node scripts/local_demo.mjs --public-testnet
node scripts/resume_local_settlement.mjs --public-testnet
```

The console at `http://127.0.0.1:8789/` offers the same new-job and retained-job actions. Its commands use explicit supported test networks and encrypted developer-role wallets. They do not sign from the user's Brave wallet. The supplied primary address remains user-controlled for final user acceptance.

The original disposable funded developer wallet is configured through `.local/public-testnet/account-settings.json`; this file contains only keystore/password-file locations and the expected public address. `node scripts/public_testnet_accounts.mjs` creates/reuses six additional encrypted role wallets. Neither keys nor password contents belong in Git or chat. Public-network transactions never use the public Anvil mnemonic.

`public_testnet_deploy.mjs` retains stable operation IDs and signed bytes. Its exact official deployment catalogue is saved in `.local/public-testnet/official-uniswap-deployments.json`, sourced from `https://developers.uniswap.org/deployments.json` with client identifier `AgentCity/0.1`. Preserve its deployment progress and keystores with operator backups; do not delete them to retry a failed transaction. Missing or expired unsigned setup can be refreshed only before an original intent exists. A canonically reverted seed needs a separately recorded retry; uncertain signed bytes are never silently replaced.

## Authority and retry behavior

Seven distinct roles separate administration, issuance, state publication, inventory delivery, inspection, requester and builder authority. Signed gas/value commitments are capped for faucet-funded development. Mainnet is unsupported. Before a real-value release, network-specific total fee accounting and operating limits require review.

Every confirmed purchase reserves the agreed material cap, obtains one real hook-checked v4 swap, burns KIT into a canonical claim, and delivers one synthetic bundle. Burned-but-undelivered liabilities remain backed. Offchain recipients cannot be changed by the model.

Arkiv publishing uses the official SDK. The signed raw transaction is persisted before sending; loss of the local result is reconciled from that same transaction and owner-bound record. It does not publish a second entity. Public claim-event lookup is bounded to the retained purchase receipt block.

`resume_local_settlement.mjs --public-testnet` reconciles the retained job's original purchase and resumes its remaining delivery, construction, inspection and settlement steps. It never creates another procurement operation. Repeating an already settled job creates no further chain transaction or payment. Canonical block-hash disagreement is retained as a reorganization fence rather than treated as permission to send again.

## Verification and release limits

The public flow has actual transactions, signatures and official-SDK discovery. Its game sessions, inventory, construction and inspection are synthetic fixtures. Actual Minecraft 144/16-of-16 evidence is separate and never substituted into contract acceptance.

The funded labor example is six test CRED; one synthetic KIT purchase is capped at three test CRED. Both tokens use 18 decimals. This is disclosed test liquidity, not an organic market, a price promise or a cash-out game economy.

The private laptop pilot still needs final independent-human acceptance and authenticated multiplayer. Operator backups are local; off-device disaster storage is not yet established. The original canonical 0G/integrated-token specification remains unpassed; this deployment follows the explicitly revised route.
