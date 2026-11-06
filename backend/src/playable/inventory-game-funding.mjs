import { createHash } from 'node:crypto'
import { encodeFunctionData, parseAbi, parseEventLogs } from 'viem'
import { digest, json, lower } from '../world-assets/canonical.mjs'
import { TEST_GAME_CITY_AMOUNT, TEST_GAME_NATIVE_AMOUNT, testGameGrantOperationIds } from '../bank/operator-wallets.mjs'

const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i
const HASH = /^0x[a-f0-9]{64}$/i
const fail = code => { throw Object.assign(Error(code), { code }) }
const abi = parseAbi(['function transfer(address to,uint256 value) returns(bool)', 'event Transfer(address indexed from,address indexed to,uint256 value)'])
const disclosure = 'One-time game-wallet starter subsidy: 1 test CITY and 0.0001 test ETH from existing controlled funds. Not earnings or USD value. The earlier external-wallet grant is separate and unchanged.'

export async function createInventoryGameFunding({ pool, manifest, wallets, client, resolveIdentity, authorize } = {}) {
  if (!pool?.query || !wallets?.testGameGrant || !client || typeof resolveIdentity !== 'function' || typeof authorize !== 'function') fail('INVENTORY_GAME_FUNDING_CONFIGURATION_REQUIRED')
  await pool.query(`CREATE TABLE IF NOT EXISTS ac_inventory_game_starter_grants(
    grant_id integer PRIMARY KEY CHECK(grant_id=1),operation_id uuid NOT NULL UNIQUE,principal_id uuid NOT NULL UNIQUE,
    wallet_id text NOT NULL UNIQUE,subject_hash text NOT NULL,recipient text NOT NULL UNIQUE,source text NOT NULL,
    terms_digest text NOT NULL,terms jsonb NOT NULL,state text NOT NULL DEFAULT 'preview',consent jsonb,
    city_hash text,native_hash text,city_receipt jsonb,native_receipt jsonb,created_at timestamptz NOT NULL DEFAULT now());
    CREATE OR REPLACE FUNCTION ac_protect_inventory_game_starter_grant() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF (NEW.operation_id,NEW.principal_id,NEW.wallet_id,NEW.subject_hash,NEW.recipient,NEW.source,NEW.terms_digest,NEW.terms,NEW.created_at)
        IS DISTINCT FROM (OLD.operation_id,OLD.principal_id,OLD.wallet_id,OLD.subject_hash,OLD.recipient,OLD.source,OLD.terms_digest,OLD.terms,OLD.created_at)
        OR (OLD.consent IS NOT NULL AND NEW.consent IS DISTINCT FROM OLD.consent)
        OR (OLD.city_hash IS NOT NULL AND NEW.city_hash IS DISTINCT FROM OLD.city_hash)
        OR (OLD.native_hash IS NOT NULL AND NEW.native_hash IS DISTINCT FROM OLD.native_hash)
        OR (OLD.city_receipt IS NOT NULL AND NEW.city_receipt IS DISTINCT FROM OLD.city_receipt)
        OR (OLD.native_receipt IS NOT NULL AND NEW.native_receipt IS DISTINCT FROM OLD.native_receipt)
        OR (OLD.state IN ('complete','reverted') AND NEW.state IS DISTINCT FROM OLD.state)
        THEN RAISE EXCEPTION 'INVENTORY_GAME_STARTER_GRANT_IMMUTABLE'; END IF;
      RETURN NEW; END; $$;
    DROP TRIGGER IF EXISTS protect_inventory_game_starter_grant ON ac_inventory_game_starter_grants;
    CREATE TRIGGER protect_inventory_game_starter_grant BEFORE UPDATE ON ac_inventory_game_starter_grants FOR EACH ROW EXECUTE FUNCTION ac_protect_inventory_game_starter_grant();`)
  const read = async () => (await pool.query('SELECT * FROM ac_inventory_game_starter_grants WHERE grant_id=1')).rows[0]
  const view = row => ({ operationId: row.operation_id, termsDigest: row.terms_digest, status: row.state, consented: Boolean(row.consent),
    terms: row.terms, cityReceipt: row.city_receipt, nativeReceipt: row.native_receipt, cityLabel: '1 CITY', nativeLabel: '0.0001 test ETH', disclosure,
    message: row.state === 'complete' ? 'Your game-wallet starter funds are confirmed. Buying materials still needs its own confirmation.'
      : row.state === 'reverted' ? 'An original starter transfer reverted. Keep its receipts for operator review; no replacement transfer was created.'
        : row.consent ? 'Original starter transfers are pending. Check the same grant; no replacement transfer is needed.'
          : 'Review 1 test CITY and 0.0001 test ETH to your verified game wallet. Confirm this starter grant separately from a purchase.' })
  async function context(principalId) {
    if (!UUID.test(principalId || '')) fail('INVENTORY_GAME_FUNDING_OWNER_REQUIRED')
    const owner = await resolveIdentity({ principalId })
    if (owner?.principalId !== principalId || !/^did:privy:[A-Za-z0-9:_-]+$/.test(owner.privySubject || '') ||
        owner.nativeApproved !== true || owner.managedWalletVerified !== true) fail('INVENTORY_GAME_FUNDING_VERIFIED_MANAGED_WALLET_REQUIRED')
    const binding = { principalId, recipient: lower(owner.walletAddress), walletId: owner.walletId,
      subjectHash: createHash('sha256').update(owner.privySubject).digest('hex') }
    const ids = testGameGrantOperationIds(manifest, binding), signer = await wallets.testGameGrant(binding)
    if (['grant', 'city', 'native'].some(leg => signer.operationIds?.[leg] !== ids[leg])) fail('INVENTORY_GAME_FUNDING_ORIGINAL_JOURNAL_REQUIRED')
    const terms = { recipient: binding.recipient, walletId: binding.walletId, city: manifest.city.toLowerCase(), source: lower(signer.address),
      cityAmountBaseUnits: String(TEST_GAME_CITY_AMOUNT), nativeAmountWei: String(TEST_GAME_NATIVE_AMOUNT), chainId: 1301, maximumGrants: 1, operationIds: ids }
    return { binding, signer, ids, terms, termsDigest: digest({ principalId, subjectHash: binding.subjectHash, ...terms }) }
  }
  async function preview({ principalId }) {
    const current = await context(principalId)
    await pool.query(`INSERT INTO ac_inventory_game_starter_grants(grant_id,operation_id,principal_id,wallet_id,subject_hash,recipient,source,terms_digest,terms)
      VALUES(1,$1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING`, [current.ids.grant, principalId, current.binding.walletId,
      current.binding.subjectHash, current.binding.recipient, current.terms.source, current.termsDigest, json(current.terms)])
    const row = await read()
    if (row.operation_id !== current.ids.grant || row.principal_id !== principalId || row.terms_digest !== current.termsDigest ||
        digest(row.terms) !== digest(current.terms)) fail('INVENTORY_GAME_FUNDING_QUOTA_OR_BINDING_CONFLICT')
    return view(row)
  }
  async function confirm({ principalId, termsDigest, confirmationId }) {
    const current = await context(principalId), shown = await preview({ principalId })
    if (shown.termsDigest !== termsDigest || current.termsDigest !== termsDigest || !UUID.test(confirmationId || '')) fail('INVENTORY_GAME_FUNDING_EXPLICIT_CONFIRMATION_REQUIRED')
    let row = await read()
    if (['complete', 'reverted'].includes(row.state)) return view(row)
    if (!row.consent) {
      const request = { kind: 'privy-game-starter-grant', principalId, operationId: current.ids.grant, termsDigest, confirmationId, ...current.terms }
      const accepted = await authorize(request)
      if (accepted?.authorized !== true || ['kind', 'principalId', 'operationId', 'termsDigest', 'confirmationId', 'recipient', 'walletId', 'city', 'cityAmountBaseUnits', 'nativeAmountWei', 'chainId']
        .some(key => accepted[key] !== request[key])) fail('INVENTORY_GAME_FUNDING_EXPLICIT_CONFIRMATION_REQUIRED')
      await current.signer.preflight()
      await pool.query("UPDATE ac_inventory_game_starter_grants SET consent=$1,state='funding' WHERE grant_id=1 AND consent IS NULL", [json(accepted)])
      row = await read()
    }
    for (const leg of ['city', 'native']) {
      if (row[leg + '_receipt']) continue
      const to = leg === 'city' ? current.terms.city : current.terms.recipient
      const data = leg === 'city' ? encodeFunctionData({ abi, functionName: 'transfer', args: [current.terms.recipient, TEST_GAME_CITY_AMOUNT] }) : '0x'
      const value = leg === 'native' ? TEST_GAME_NATIVE_AMOUNT : 0n, operationId = current.ids[leg]
      const prepared = await current.signer.prepare({ operationId, to, data, value, limits: { maxGas: 100000, maxNativeCostWei: manifest.maxNativeCostWei } })
      const originalHash = prepared.transactionHash || prepared.hash
      if (!HASH.test(originalHash || '')) fail('INVENTORY_GAME_FUNDING_ORIGINAL_TRANSACTION_REQUIRED')
      await pool.query(`UPDATE ac_inventory_game_starter_grants SET ${leg}_hash=$1 WHERE grant_id=1 AND ${leg}_hash IS NULL`, [originalHash.toLowerCase()])
      row = await read()
      if (row[leg + '_hash'] !== originalHash.toLowerCase()) fail('INVENTORY_GAME_FUNDING_ORIGINAL_TRANSACTION_REQUIRED')
      await current.signer.broadcast({ operationId })
      const result = await current.signer.reconcile({ operationId })
      if (result.status === 'reverted' || result.receipt?.status === 'reverted') return view((await pool.query("UPDATE ac_inventory_game_starter_grants SET state='reverted' WHERE grant_id=1 RETURNING *")).rows[0])
      if (result.status !== 'confirmed') return view(row)
      const transactionHash = result.transactionHash || result.hash, receipt = result.receipt
      if (transactionHash?.toLowerCase() !== row[leg + '_hash'] || receipt?.status !== 'success') fail('INVENTORY_GAME_FUNDING_CANONICAL_RECEIPT_REQUIRED')
      const [transaction, head, block] = await Promise.all([client.getTransaction({ hash: transactionHash }), client.getBlockNumber({ cacheTime: 0 }), client.getBlock({ blockNumber: receipt.blockNumber })])
      if (lower(transaction.from) !== current.terms.source || lower(transaction.to) !== to || transaction.input.toLowerCase() !== data.toLowerCase() ||
          BigInt(transaction.value) !== value || head < BigInt(receipt.blockNumber) + 1n || block.hash.toLowerCase() !== receipt.blockHash.toLowerCase()) fail('INVENTORY_GAME_FUNDING_CANONICAL_RECEIPT_REQUIRED')
      if (leg === 'city') {
        const transfers = parseEventLogs({ abi, eventName: 'Transfer', logs: receipt.logs, strict: true }).filter(log => lower(log.address) === to && lower(log.args.from) === current.terms.source && lower(log.args.to) === current.terms.recipient && log.args.value === TEST_GAME_CITY_AMOUNT)
        if (transfers.length !== 1) fail('INVENTORY_GAME_FUNDING_EXACT_CITY_TRANSFER_REQUIRED')
      }
      const proof = { transactionHash, blockNumber: String(receipt.blockNumber), blockHash: receipt.blockHash, confirmations: 2,
        source: current.terms.source, recipient: current.terms.recipient, amountBaseUnits: leg === 'city' ? String(TEST_GAME_CITY_AMOUNT) : String(TEST_GAME_NATIVE_AMOUNT) }
      row = (await pool.query(`UPDATE ac_inventory_game_starter_grants SET ${leg}_receipt=$1 WHERE grant_id=1 RETURNING *`, [json(proof)])).rows[0]
    }
    return view((await pool.query("UPDATE ac_inventory_game_starter_grants SET state='complete' WHERE grant_id=1 AND city_receipt IS NOT NULL AND native_receipt IS NOT NULL RETURNING *")).rows[0])
  }
  return { preview, confirm }
}
