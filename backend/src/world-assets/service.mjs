import { createPublicClient, http, encodeFunctionData, keccak256, stringToHex, zeroAddress } from 'viem'
import { createHash } from 'node:crypto'
import { registryAbi, assetMarketAbi, cityAbi } from './abis.mjs'
import { createCanonicalReader, validateWorldAssetManifest, digest, json, lower, hex32 } from './canonical.mjs'
import { createWorldAssetStore } from './store.mjs'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const id = value => { const h = createHash('sha256').update(String(value)).digest('hex'); return `${h.slice(0,8)}-${h.slice(8,12)}-4${h.slice(13,16)}-a${h.slice(17,20)}-${h.slice(20,32)}` }
const bytes = value => hex32(value) ? value.toLowerCase() : keccak256(stringToHex(String(value)))
const fingerprint = value => { if (!/^[a-f0-9]{64}$/i.test(value || '')) throw Error('WORLD_ASSET_NATIVE_FINGERPRINT_REQUIRED'); return '0x' + value.toLowerCase() }
const fail = message => { throw Error(message) }
const nativeNumber = value => { const number = Number(value); if (!Number.isSafeInteger(number) || number < 0) fail('WORLD_ASSET_NATIVE_INTEGER_RANGE'); return number }

// The signing adapters are existing durable managed-wallet tools, not model
// tools. Registrar and player authorities remain separate and bounded by policy.
export async function createWorldAssets({ pool, store: suppliedStore, manifest: input, client: suppliedClient,
  wallets, registrar, resolveIdentity, resolveWalletOwner, authorize, native, allowLocalFixture = false } = {}) {
  if (!wallets?.prepare || !wallets?.broadcast || !wallets?.reconcile || !registrar?.address || !registrar?.prepare || !registrar?.broadcast || !registrar?.reconcile || typeof resolveIdentity !== 'function' || typeof resolveWalletOwner !== 'function' || typeof authorize !== 'function' || typeof native !== 'function') fail('WORLD_ASSET_MANAGED_AUTHORITIES_REQUIRED')
  const manifest = validateWorldAssetManifest(input, { allowLocalFixture }), deployment = manifest.deploymentId, manifestDigest = digest(manifest)
  const store = suppliedStore || await createWorldAssetStore(pool)
  const client = suppliedClient || createPublicClient({ transport: http(manifest.rpcUrl, { retryCount: 0, timeout: 15000 }) })
  const reader = createCanonicalReader({ client, manifest })
  await reader.verify()
  const configuration = { chainId: manifest.chainId, registry: manifest.registry, deploymentId: deployment, codeHash: manifest.codeHashes.registry }
  const get = key => store.get(deployment, key), put = (key, body) => store.put(deployment, key, json(body))
  async function actor(principalId) {
    if (!UUID.test(principalId || '')) fail('WORLD_ASSET_VERIFIED_OWNER_REQUIRED')
    const value = await resolveIdentity({ principalId })
    if (!value || value.principalId !== principalId || !value.privySubject || !UUID.test(value.minecraftPlayerId || '') || !value.walletAddress) fail('WORLD_ASSET_PRIVY_MINECRAFT_BINDING_REQUIRED')
    return { ...value, walletAddress: lower(value.walletAddress), subjectHash: digest(value.privySubject) }
  }
  const binding = owner => ({ principalId: owner.principalId, minecraftPlayerId: owner.minecraftPlayerId, walletAddress: owner.walletAddress, subjectHash: owner.subjectHash })
  async function session(owner) {
    const value = await native('session?playerId=' + owner.minecraftPlayerId)
    if (!value.online || value.pendingAuthentication !== false || value.principalId !== owner.principalId || !UUID.test(value.connectionId || '') || value.authenticationKind === 'unverified_local_connection') fail('WORLD_ASSET_APPROVED_GAME_SESSION_REQUIRED')
    return value
  }
  async function source(owner, request) {
    if (request.sourceKind === 'agent_inventory') {
      const entry = owner.agentInventories?.find(value => value.agentId === request.agentId)
      if (!entry || !UUID.test(entry.sourceId || '')) fail('WORLD_ASSET_OWN_AGENT_REQUIRED')
      return { sourceKind: 'agent_inventory', sourceId: entry.sourceId }
    }
    if (request.sourceKind !== 'player_inventory') fail('WORLD_ASSET_NATIVE_SOURCE_REQUIRED')
    const active = await session(owner)
    return { sourceKind: 'player_inventory', sourceId: owner.minecraftPlayerId, connectionId: active.connectionId }
  }
  async function ownedRecord(principalId, operationId) {
    const owner = await actor(principalId), row = await get('operation:' + id(operationId)) || (UUID.test(operationId || '') ? await get('operation:' + operationId) : null)
    if (!row || row.principalId !== principalId || row.manifestDigest !== manifestDigest || digest(row.owner) !== digest(binding(owner))) fail('WORLD_ASSET_IMMUTABLE_REQUEST_OWNER_REQUIRED')
    return { owner, row }
  }
  const visible = row => json({ operationId: row.originalOperationId, previewId: row.id, action: row.action, termsDigest: row.termsDigest,
    status: row.status, expiresAtMs: row.expiresAtMs, terms: row.terms, tokenId: row.tokenId || null, proofs: Object.values(row.stages || {}).map(stage => stage.proof).filter(Boolean), message: row.message })
  async function preview(request) {
    if (!request || typeof request.operationId !== 'string' || !request.operationId || request.operationId.length > 200) fail('WORLD_ASSET_OPERATION_REQUIRED')
    const operation = id(request.operationId)
    return store.lock(deployment, operation, async () => {
      const owner = await actor(request.principalId), previous = await get('operation:' + operation), inputDigest = digest(request)
      if (previous) { if (previous.inputDigest !== inputDigest || digest(previous.owner) !== digest(binding(owner))) fail('WORLD_ASSET_REQUEST_TERMS_CHANGED'); return visible(previous) }
      const block = await reader.snapshot(), action = request.action
      let terms
      if (action === 'mint' && request.kind === 'item') {
        const count = request.count ?? 1
        if (!Number.isInteger(count) || count < 1 || count > 64) fail('WORLD_ASSET_ITEM_LOT_COUNT_REQUIRED')
        const inventory = await source(owner, request)
        const selection = request.selection ?? 'main_hand'
        if (selection !== 'main_hand' && (!Number.isInteger(selection) || selection < 0 || selection > 35)) fail('WORLD_ASSET_EQUIPMENT_SELECTION_REQUIRED')
        const actual = await native('escrow/preview', { operationId: operation, sellerId: owner.principalId, sellerAccountId: owner.minecraftPlayerId,
          ownerPlayerId: owner.minecraftPlayerId, ...inventory, ...(selection === 'main_hand' ? { selection } : { slot: selection }), count })
        if (actual.previewId !== operation || actual.sourceId !== inventory.sourceId || !actual.worldName || actual.count !== count || actual.expiresAtMs <= Date.now()) fail('WORLD_ASSET_NATIVE_PREVIEW_BINDING_CHANGED')
        terms = { kind: 'item', inventory, nativePreview: actual, worldId: bytes(actual.worldName), snapshotHash: fingerprint(actual.fingerprint), custodyId: bytes(operation) }
      } else if (action === 'mint' && request.kind === 'parcel' || action === 'snapshot') {
        const active = await session(owner), actual = await native('property/preview', { operationId: operation, parcelId: request.parcelId,
          ownerPrincipalId: owner.principalId, ownerPlayerId: owner.minecraftPlayerId, connectionId: active.connectionId })
        const parcel = actual.parcel || actual
        const catalogDigest = parcel.catalogDigest || parcel.termsDigest
        if (parcel.parcelId !== request.parcelId || !parcel.world || !hex32('0x' + String(catalogDigest).replace(/^0x/, '')) || !Number.isInteger(parcel.cellX) || !Number.isInteger(parcel.cellZ)) fail('WORLD_ASSET_FIXED_PARCEL_REQUIRED')
        const min = parcel.bounds?.min, max = parcel.bounds?.max
        const axis = (v, key, index) => v?.[key] ?? v?.[index]
        if (axis(min, 'x', 0) !== parcel.cellX * 16 || axis(min, 'z', 2) !== parcel.cellZ * 16 || axis(max, 'x', 0) !== parcel.cellX * 16 + 15 || axis(max, 'z', 2) !== parcel.cellZ * 16 + 15) fail('WORLD_ASSET_PARCEL_GRID_MISMATCH')
        terms = { kind: 'parcel', parcelId: parcel.parcelId, nativePreview: actual, catalogTermsDigest: catalogDigest, worldId: bytes(parcel.world),
          snapshotHash: fingerprint(actual.houseSnapshotFingerprint || actual.fingerprint), cellX: parcel.cellX, cellZ: parcel.cellZ }
        if (action === 'snapshot') {
          const asset = await reader.asset(request.tokenId, block)
          if (asset.kind !== 2 || asset.owner !== owner.walletAddress || asset.worldId !== terms.worldId || Number(asset.cellX) !== terms.cellX || Number(asset.cellZ) !== terms.cellZ) fail('WORLD_ASSET_OWN_PARCEL_REVISION_REQUIRED')
          terms.asset = asset
        }
      } else if (['list', 'buy', 'cancel', 'redeem'].includes(action)) {
        const asset = await reader.asset(request.tokenId, block)
        const backing = await get('asset:' + String(request.tokenId))
        if (!backing || backing.snapshotHash !== asset.snapshotHash || backing.nativeReceiptId !== asset.nativeReceiptId) fail('WORLD_ASSET_NATIVE_BACKING_BINDING_REQUIRED')
        terms = { asset, backing }
        if (action !== 'buy' && asset.owner !== owner.walletAddress) fail('WORLD_ASSET_CHAIN_OWNER_REQUIRED')
        if (action === 'list') {
          if (backing.kind === 'parcel' && (await get('freeze:' + asset.tokenId))?.resolved !== true && await get('freeze:' + asset.tokenId)) fail('WORLD_ASSET_CANCEL_OR_RECONCILE_PREVIOUS_PROPERTY_LISTING_FIRST')
          if (asset.redemptionPending || asset.redeemed || !/^[1-9][0-9]*$/.test(request.priceBaseUnits || '') || BigInt(request.priceBaseUnits) > BigInt(manifest.maxPriceBaseUnits) || !Number.isSafeInteger(request.expiry) || request.expiry <= block.timestamp || request.expiry > block.timestamp + 30 * 86400) fail('WORLD_ASSET_EXACT_LISTING_LIMITS_REQUIRED')
          terms.price = request.priceBaseUnits; terms.expiry = request.expiry
        }
        if (action === 'buy' || action === 'cancel') {
          const listing = await client.readContract({ address: manifest.market, abi: assetMarketAbi, functionName: 'listings', args: [BigInt(request.tokenId)], blockNumber: BigInt(block.blockNumber) })
          const [seller, price, expiry, ownershipNonce, revision, nonce] = Array.isArray(listing) ? listing : [listing.seller, listing.price, listing.expiry, listing.ownershipNonce, listing.revision, listing.nonce]
          terms.listing = json({ seller: lower(seller), price, expiry, ownershipNonce, revision, nonce })
          if (action === 'cancel' && lower(seller) !== owner.walletAddress || action === 'buy' && (lower(seller) === owner.walletAddress || BigInt(price) < 1n || BigInt(price) > BigInt(manifest.maxPriceBaseUnits) || !await client.readContract({ address: manifest.market, abi: assetMarketAbi, functionName: 'isListingActive', args: [BigInt(request.tokenId)], blockNumber: BigInt(block.blockNumber) }))) fail('WORLD_ASSET_LIVE_EXACT_LISTING_REQUIRED')
          if (action === 'buy' && backing.kind === 'parcel') {
            const frozen = await get('freeze:' + asset.tokenId)
            if (!frozen || frozen.resolved || !frozen.listProof || String(frozen.listProof.args.listingNonce) !== String(nonce) || frozen.ownerWallet !== lower(seller) || frozen.expectedRevision !== String(revision)) fail('WORLD_ASSET_QUALIFIED_PHYSICAL_LISTING_REQUIRED')
            await reader.snapshot(frozen.listProof)
          }
        }
        if (action === 'redeem' && (asset.kind !== 1 || asset.redemptionPending || asset.redeemed)) fail('WORLD_ASSET_REDEEMABLE_ITEM_REQUIRED')
      } else fail('WORLD_ASSET_ACTION_UNSUPPORTED')
      await reader.unchanged(block)
      const row = json({ id: operation, originalOperationId: request.operationId, inputDigest, principalId: request.principalId, owner: binding(owner), manifestDigest,
        action, terms, termsDigest: digest({ deployment, action, owner: binding(owner), terms }), status: 'preview', expiresAtMs: Math.min(Date.now() + 300000, terms.nativePreview?.expiresAtMs || Infinity),
        stages: {}, createdAtMs: Date.now(), message: 'Preview only. The requester must explicitly confirm these exact terms.' })
      await put('operation:' + operation, row); return visible(row)
    })
  }
  async function transact(row, owner, stageName, { abi, to, functionName, args, eventName, match = {}, issuer = false }) {
    const data = encodeFunctionData({ abi, functionName, args }), operationId = id(row.id + ':' + stageName), from = issuer ? lower(registrar.address) : owner.walletAddress
    let stage = row.stages[stageName]
    if (stage && (stage.to !== to || stage.data !== data || stage.from !== from)) fail('WORLD_ASSET_TRANSACTION_TERMS_CHANGED')
    stage ??= row.stages[stageName] = { operationId, to, data, from, eventName, status: 'prepared' }
    if (stage.proof) { await reader.snapshot(stage.proof); return stage.proof }
    row.status = 'pending'; row.message = `Reconciling ${stageName}; no replacement transaction or native stock is authorized.`
    await put('operation:' + row.id, row)
    const signing = issuer ? registrar : wallets, input = { ...(issuer ? {} : { playerId: owner.principalId }), operationId, to, data, value: 0n,
      limits: { maxGas: Number(manifest.maxGas), maxNativeCostWei: manifest.maxNativeCostWei } }
    await signing.prepare(input); await signing.broadcast(issuer ? { operationId } : { playerId: owner.principalId, operationId })
    const result = await signing.reconcile(issuer ? { operationId } : { playerId: owner.principalId, operationId })
    const transactionHash = result.transactionHash || result.hash
    if (!hex32(transactionHash)) return null
    stage.transactionHash = transactionHash; await put('operation:' + row.id, row)
    const proof = await reader.transaction({ transactionHash, from, to, data, eventName, match })
    if (!proof.confirmed) { row.message = proof.reason; await put('operation:' + row.id, row); return null }
    stage.status = 'confirmed'; stage.proof = proof; await put('operation:' + row.id, row); return proof
  }
  async function reserveItem(row, owner) {
    if (row.nativeReceipt) return row.nativeReceipt
    const actual = row.terms.nativePreview, stockOperationId = id(row.id + ':stock'), known = await native('escrow/status', { operationId: stockOperationId })
    const stock = { operationId: stockOperationId, listingId: row.id, sellerId: owner.principalId, sellerAccountId: owner.minecraftPlayerId,
      sourceId: row.terms.inventory.sourceId, sourceKind: row.terms.inventory.sourceKind, item: actual.item, count: actual.count, termsDigest: row.termsDigest,
      custodyMode: 'world_asset', previewId: actual.previewId, expectedFingerprint: actual.fingerprint }
    let receipt
    if (known.known === true && known.receipt?.escrowed === true) receipt = known.receipt
    else if (known.known === true && known.pending === true) {
      if (!UUID.test(known.receipt?.authorityId || '') || Object.entries(stock).some(([key, value]) => known.receipt[key] !== value)) fail('WORLD_ASSET_ORIGINAL_NATIVE_INTENT_REQUIRED')
      receipt = await native('escrow/reserve', { ...stock, authorityId: known.receipt.authorityId })
    } else if (known.known === false) {
      row.stockAuthority ??= { ...stock, authorityId: id(row.id + ':authority'), ownerPlayerId: owner.minecraftPlayerId,
        consentId: row.id, confirmed: true, expiresAtMs: row.consentedAtMs + 300000, ...(row.terms.inventory.connectionId ? { connectionId: row.terms.inventory.connectionId } : {}) }
      await put('operation:' + row.id, row)
      await native('escrow/authorize', row.stockAuthority)
      receipt = await native('escrow/reserve', { ...stock, authorityId: row.stockAuthority.authorityId })
    } else fail('WORLD_ASSET_NATIVE_STOCK_UNCERTAIN')
    if (receipt.escrowed !== true || receipt.listingId !== row.id || receipt.fingerprint !== actual.fingerprint || receipt.custodyMode !== 'world_asset' || receipt.item !== actual.item || receipt.count !== actual.count) fail('WORLD_ASSET_EXACT_NATIVE_CUSTODY_REQUIRED')
    row.nativeReceipt = receipt; await put('operation:' + row.id, row); return receipt
  }
  async function confirm({ principalId, operationId, previewId, termsDigest, confirmationId }) {
    const record = await ownedRecord(principalId, previewId || operationId)
    return store.lock(deployment, record.row.id, async () => {
      const { owner, row } = await ownedRecord(principalId, record.row.originalOperationId)
      if (termsDigest !== row.termsDigest) fail('WORLD_ASSET_EXACT_REQUESTER_TERMS_REQUIRED')
      await reader.verify()
      if (!row.consentedAtMs) {
        if (Date.now() >= row.expiresAtMs) fail('WORLD_ASSET_PREVIEW_EXPIRED')
        const accepted = await authorize({ principalId, operationId: row.originalOperationId, confirmationId, action: row.action, termsDigest: row.termsDigest, owner: row.owner })
        if (accepted !== true && !(accepted?.approved === true && accepted.principalId === principalId && accepted.termsDigest === row.termsDigest)) fail('WORLD_ASSET_EXPLICIT_REQUESTER_APPROVAL_REQUIRED')
        row.consentedAtMs = Date.now(); row.consentId = confirmationId; row.status = 'prepared'; await put('operation:' + row.id, row)
      }
      if (row.status === 'complete') { for (const stage of Object.values(row.stages)) if (stage.proof) await reader.snapshot(stage.proof); return visible(row) }
      try {
        let proof
        const terms = row.terms, asset = terms.asset
        if (row.action === 'mint' || row.action === 'snapshot') {
          const receipt = terms.kind === 'item' ? await reserveItem(row, owner) : terms.nativePreview
          const nativeReceiptId = bytes(digest(receipt)), custodyKey = terms.kind === 'item' ? `custody:${row.id}` : row.action === 'snapshot' ? `snapshot:${terms.parcelId}:${asset.revision}` : `parcel:${terms.worldId}:${terms.cellX}:${terms.cellZ}`
          await store.backing(deployment, nativeReceiptId, custodyKey, row.id)
          const functionName = row.action === 'snapshot' ? 'updateParcelSnapshot' : terms.kind === 'item' ? 'mintItem' : 'mintParcel'
          const args = row.action === 'snapshot' ? [BigInt(asset.tokenId), BigInt(asset.revision), terms.snapshotHash, nativeReceiptId]
            : terms.kind === 'item' ? [owner.walletAddress, manifest.serverId, terms.worldId, terms.custodyId, terms.snapshotHash, nativeReceiptId]
              : [owner.walletAddress, manifest.serverId, terms.worldId, terms.cellX, terms.cellZ, terms.snapshotHash, nativeReceiptId]
          proof = await transact(row, owner, 'register', { abi: registryAbi, to: manifest.registry, functionName, args, issuer: true,
            eventName: row.action === 'snapshot' ? 'ParcelSnapshotUpdated' : 'AssetRegistered', match: { nativeReceiptId, ...(row.action === 'snapshot' ? { tokenId: asset.tokenId } : { serverId: manifest.serverId, worldId: terms.worldId, snapshotHash: terms.snapshotHash }) } })
          if (!proof) return visible(row)
          row.tokenId = String(proof.args.tokenId)
          const snapshot = await reader.snapshot(proof), current = await reader.asset(row.tokenId, snapshot)
          if (current.nativeReceiptId !== nativeReceiptId || current.snapshotHash !== terms.snapshotHash || current.worldId !== terms.worldId) fail('WORLD_ASSET_REGISTERED_BACKING_CHANGED')
          const record = { tokenId: row.tokenId, kind: terms.kind, nativeListingId: row.id, nativeReceiptId, snapshotHash: terms.snapshotHash,
            fingerprint: terms.kind === 'item' ? receipt.fingerprint : terms.nativePreview.houseSnapshotFingerprint || terms.nativePreview.fingerprint,
            worldId: terms.worldId, parcelId: terms.parcelId || null, descriptor: terms.nativePreview.descriptor || null,
            ...(terms.kind === 'item' ? { item: receipt.item, count: receipt.count } : {}),
            catalogTermsDigest: terms.catalogTermsDigest || null, termsDigest: row.termsDigest, proof, revision: current.revision }
          await put('asset:' + row.tokenId, record)
          if (terms.kind === 'item') {
            await native('escrow/asset-configure', { operationId: id(deployment + ':asset-configure'), ...configuration })
            await native('escrow/asset-bind', { operationId: id(row.id + ':bind'), listingId: row.id, tokenId: row.tokenId, ...configuration,
              blockNumber: nativeNumber(proof.blockNumber), blockHash: proof.blockHash, transactionHash: proof.transactionHash, fingerprint: receipt.fingerprint,
              termsDigest: row.termsDigest, confirmed: true, confirmations: proof.confirmations })
          }
        } else if (row.action === 'list') {
          if (!row.stages.list?.proof) {
            const block = await reader.snapshot(), current = await reader.asset(asset.tokenId, block)
            if (current.owner !== owner.walletAddress || current.ownershipNonce !== asset.ownershipNonce || current.revision !== asset.revision || current.redemptionPending) fail('WORLD_ASSET_OWNER_OR_REVISION_CHANGED')
            if (terms.backing.kind === 'parcel') {
            row.propertyFreeze ??= { operationId: id(row.id + ':property-freeze'), parcelId: terms.backing.parcelId, assetId: asset.tokenId,
              ownerPrincipalId: owner.principalId, expectedFingerprint: terms.backing.fingerprint }
            await put('operation:' + row.id, row)
            const oldFreeze = await get('freeze:' + asset.tokenId)
            if (oldFreeze && !oldFreeze.resolved && oldFreeze.operationId !== row.propertyFreeze.operationId) fail('WORLD_ASSET_EXISTING_PROPERTY_FREEZE_REQUIRED')
            await put('freeze:' + asset.tokenId, { ...row.propertyFreeze, sourceBlock: String(block.blockNumber), ownerWallet: owner.walletAddress,
              expectedOwnershipNonce: asset.ownershipNonce, expectedRevision: asset.revision, resolved: false })
            await native('property/freeze', row.propertyFreeze)
            }
            if (!await transact(row, owner, 'nft-approval', { abi: registryAbi, to: manifest.registry, functionName: 'approve', args: [manifest.market, BigInt(asset.tokenId)] })) return visible(row)
          }
          proof = await transact(row, owner, 'list', { abi: assetMarketAbi, to: manifest.market, functionName: 'list', args: [BigInt(asset.tokenId), BigInt(terms.price), BigInt(terms.expiry), BigInt(asset.ownershipNonce), BigInt(asset.revision)], eventName: 'AssetListed', match: { tokenId: asset.tokenId, seller: owner.walletAddress, price: terms.price, expiry: terms.expiry, ownershipNonce: asset.ownershipNonce, revision: asset.revision } })
          if (proof && row.propertyFreeze) await put('freeze:' + asset.tokenId, { ...(await get('freeze:' + asset.tokenId)), listProof: proof })
        } else if (row.action === 'buy') {
          const offer = terms.listing
          if (!await transact(row, owner, 'city-approval', { abi: cityAbi, to: manifest.city, functionName: 'approve', args: [manifest.market, BigInt(offer.price)] })) return visible(row)
          proof = await transact(row, owner, 'buy', { abi: assetMarketAbi, to: manifest.market, functionName: 'buy', args: [BigInt(asset.tokenId), offer.seller, BigInt(offer.price), BigInt(offer.nonce), BigInt(offer.ownershipNonce), BigInt(offer.revision)], eventName: 'AssetPurchased', match: { tokenId: asset.tokenId, seller: offer.seller, buyer: owner.walletAddress, price: offer.price, listingNonce: offer.nonce, revision: offer.revision } })
        } else if (row.action === 'cancel') {
          proof = await transact(row, owner, 'cancel', { abi: assetMarketAbi, to: manifest.market, functionName: 'cancel', args: [BigInt(asset.tokenId), BigInt(terms.listing.nonce)], eventName: 'AssetListingCancelled', match: { tokenId: asset.tokenId, seller: owner.walletAddress, listingNonce: terms.listing.nonce } })
        } else if (row.action === 'redeem') {
          const claimId = bytes(row.id + ':claim')
          proof = await transact(row, owner, 'request-redemption', { abi: registryAbi, to: manifest.registry, functionName: 'requestRedemption', args: [BigInt(asset.tokenId), BigInt(asset.ownershipNonce), claimId], eventName: 'RedemptionRequested', match: { tokenId: asset.tokenId, claimId, owner: owner.walletAddress, ownershipNonce: String(BigInt(asset.ownershipNonce) + 1n) } })
          if (!proof) return visible(row)
          const block = await reader.snapshot(proof), current = await reader.asset(asset.tokenId, block)
          const claim = await client.readContract({ address: manifest.registry, abi: registryAbi, functionName: 'claims', args: [claimId], blockNumber: BigInt(block.blockNumber) })
          const [claimToken, claimOwner, expectedNonce] = Array.isArray(claim) ? claim : [claim.tokenId, claim.owner, claim.expectedOwnershipNonce]
          if (String(claimToken) !== asset.tokenId || lower(claimOwner) !== owner.walletAddress || String(expectedNonce) !== asset.ownershipNonce || !current.redemptionPending && !current.redeemed) fail('WORLD_ASSET_CANONICAL_CLAIM_BINDING_CHANGED')
          if (!row.releaseReceipt) {
            await native('escrow/asset-configure', { operationId: id(deployment + ':asset-configure'), ...configuration })
            row.releaseReceipt = await native('escrow/asset-release', { operationId: id(row.id + ':release'), listingId: terms.backing.nativeListingId,
              ownerId: owner.principalId, tokenId: asset.tokenId, claimId, ...configuration, blockNumber: nativeNumber(proof.blockNumber), blockHash: proof.blockHash,
              transactionHash: proof.transactionHash, fingerprint: terms.backing.fingerprint, termsDigest: terms.backing.termsDigest, confirmed: true, confirmations: proof.confirmations })
            if (row.releaseReceipt.assigned !== true || row.releaseReceipt.ownerId !== owner.principalId || row.releaseReceipt.fingerprint !== terms.backing.fingerprint) fail('WORLD_ASSET_EXACT_NATIVE_REDEMPTION_RECEIPT_REQUIRED')
            if (terms.backing.item && row.releaseReceipt.item !== terms.backing.item || terms.backing.count !== undefined && row.releaseReceipt.count !== terms.backing.count) fail('WORLD_ASSET_NATIVE_REDEMPTION_LOT_CHANGED')
            await put('operation:' + row.id, row)
          }
          const deliveryReceiptId = bytes(digest(row.releaseReceipt))
          proof = await transact(row, owner, 'finalize-redemption', { abi: registryAbi, to: manifest.registry, functionName: 'finalizeRedemption', args: [BigInt(asset.tokenId), claimId, deliveryReceiptId], issuer: true, eventName: 'RedemptionFinalized', match: { tokenId: asset.tokenId, claimId, nativeDeliveryReceiptId: deliveryReceiptId, owner: owner.walletAddress } })
        }
        if (!proof) return visible(row)
        if (['buy', 'cancel'].includes(row.action) && terms.backing.kind === 'parcel') {
          const freeze = await get('freeze:' + asset.tokenId)
          if (freeze && !freeze.resolved) await put('resolution:' + asset.tokenId, { resolvedOperationId: freeze.operationId,
            marketResolution: row.action === 'buy' ? 'confirmed_purchase' : 'confirmed_cancel', resolutionTransactionHash: proof.transactionHash, proof })
        }
        row.status = 'complete'; row.message = row.action === 'redeem' ? 'Canonical redemption finalized. Exact native items remain backed in the owner mailbox until claimed.' : 'Confirmed on the pinned test chain; rights still require a fresh canonical native projection.'
        await put('operation:' + row.id, row); return visible(row)
      } catch (error) {
        row.status = 'reconciliation_required'; row.message = error.message; await put('operation:' + row.id, row)
        throw error
      }
    })
  }
  async function sync() {
    return store.lock(deployment, 'projection', async () => {
      const previous = await get('projection')
      let revision = Number(previous?.revision || 0) + 1
      try {
        const block = await reader.snapshot(previous?.anchor), records = await store.list(deployment, 'asset:'), parcels = []
        const nativeStatus = await native('property/status', {}), catalog = nativeStatus.catalog || nativeStatus.parcels
        revision = Math.max(revision, nativeNumber(nativeStatus.revision || 0) + 1)
        if (!Array.isArray(catalog) || catalog.length !== 4 || new Set(catalog.map(parcel => parcel.parcelId)).size !== 4) fail('WORLD_ASSET_FULL_FIXED_CATALOG_REQUIRED')
        if (previous?.pending && previous.pending.expiresAtMs > Date.now() && String(block.blockNumber) === String(previous.anchor.blockNumber) && block.blockHash === previous.anchor.blockHash) {
          await native('property/configure', { operationId: id(deployment + ':property-configure'), ...configuration })
          await native('property/apply', previous.pending)
          await put('projection-operation:' + previous.pending.operationId, { body: previous.pending, status: 'active' })
          await put('projection', { ...previous, pending: null, status: 'active' }); return { status: 'active', revision: previous.revision }
        }
        for (const record of records.filter(value => value.kind === 'parcel')) {
          const current = await reader.asset(record.tokenId, block)
          const registered = catalog.find(parcel => parcel.parcelId === record.parcelId)
          if (!registered || (registered.catalogDigest || registered.termsDigest) !== record.catalogTermsDigest || bytes(registered.world || registered.worldName) !== record.worldId) fail('WORLD_ASSET_FIXED_CATALOG_CHANGED')
          if (current.snapshotHash !== record.snapshotHash || current.nativeReceiptId !== record.nativeReceiptId || current.redeemed) fail('WORLD_ASSET_PROPERTY_BACKING_CHANGED')
          const offer = await client.readContract({ address: manifest.market, abi: assetMarketAbi, functionName: 'listings', args: [BigInt(record.tokenId)], blockNumber: BigInt(block.blockNumber) })
          const marketLocked = await client.readContract({ address: manifest.market, abi: assetMarketAbi, functionName: 'isListingActive', args: [BigInt(record.tokenId)], blockNumber: BigInt(block.blockNumber) })
          const listingNonce = String(Array.isArray(offer) ? offer[5] : offer.nonce)
          const freeze = await get('freeze:' + record.tokenId)
          let resolution = await get('resolution:' + record.tokenId)
          if (freeze && !freeze.resolved && current.owner !== freeze.ownerWallet && !resolution) {
            const proof = await reader.ownershipProof(record.tokenId, current, freeze.sourceBlock, block)
            if (proof) { resolution = { resolvedOperationId: freeze.operationId, marketResolution: 'confirmed_owner_change', resolutionTransactionHash: proof.transactionHash, proof }; await put('resolution:' + record.tokenId, resolution) }
          }
          if (resolution) await reader.snapshot(resolution.proof)
          const resolved = resolution && freeze?.operationId === resolution.resolvedOperationId ? { resolvedOperationId: resolution.resolvedOperationId, marketResolution: resolution.marketResolution, resolutionTransactionHash: resolution.resolutionTransactionHash } : {}
          const common = { assetId: record.tokenId, parcelId: record.parcelId, catalogDigest: record.catalogTermsDigest, marketLocked: Boolean(marketLocked), listingNonce, ...resolved }
          const mapped = await resolveWalletOwner({ walletAddress: current.owner })
          if (!mapped) { parcels.push({ ...common, ownerPrincipalId: null, ownerPlayerId: null }); continue }
          const owner = await actor(mapped.principalId)
          if (owner.walletAddress !== current.owner) fail('WORLD_ASSET_WALLET_OWNER_MAPPING_CHANGED')
          parcels.push({ ...common, ownerPrincipalId: owner.principalId, ownerPlayerId: owner.minecraftPlayerId, transactionHash: record.proof.transactionHash })
        }
        for (const parcel of catalog) if (!parcels.some(value => value.parcelId === parcel.parcelId)) parcels.push({ parcelId: parcel.parcelId, ownerPrincipalId: null, ownerPlayerId: null, catalogDigest: parcel.catalogDigest || parcel.termsDigest })
        parcels.sort((a, b) => a.parcelId - b.parcelId)
        await reader.unchanged(block)
        const body = { operationId: id(`${deployment}:projection:${revision}`), revision, ...configuration, blockNumber: nativeNumber(block.blockNumber), blockHash: block.blockHash,
          observedAtMs: block.observedAtMs, expiresAtMs: Date.now() + 30000, confirmed: true, confirmations: 2, parcels }
        const state = { revision, status: 'pending', anchor: json(block), pending: body, previousPending: previous?.pending || null }
        if (previous?.pending) await put('projection-operation:' + previous.pending.operationId, { body: previous.pending, status: 'superseded_by_confirmed_projection', replacementOperationId: body.operationId })
        await put('projection-operation:' + body.operationId, { body, status: 'pending' })
        await put('projection', state)
        await native('property/configure', { operationId: id(deployment + ':property-configure'), ...configuration }); await native('property/apply', body)
        await put('projection-operation:' + body.operationId, { body, status: 'active' })
        for (const parcel of parcels) if (parcel.resolvedOperationId) {
          const frozen = await get('freeze:' + parcel.assetId)
          if (frozen?.operationId === parcel.resolvedOperationId) await put('freeze:' + parcel.assetId, { ...frozen, resolved: true, resolution: await get('resolution:' + parcel.assetId) })
        }
        await put('projection', { ...state, status: 'active', pending: null })
        return { status: 'active', revision, blockNumber: String(block.blockNumber), blockHash: block.blockHash, parcels }
      } catch (error) {
        const reason = /REORG/.test(error.message) ? 'canonical_reorg' : 'source_unavailable'
        await put('projection', { ...(await get('projection') || previous || {}), status: 'paused', reason: error.message })
        await native('property/invalidate', { operationId: id(`${deployment}:invalidate:${revision}:${reason}`), reason }).catch(() => {})
        return { status: 'paused', reason: error.message }
      }
    })
  }
  async function browse({ limit = 20 } = {}) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 20) fail('WORLD_ASSET_VIEW_LIMIT_REQUIRED')
    const block = await reader.snapshot(), rows = (await store.list(deployment, 'asset:')).slice(0, limit), views = []
    for (const row of rows) {
      const asset = await reader.asset(row.tokenId, block)
      if (asset.nativeReceiptId !== row.nativeReceiptId || asset.snapshotHash !== row.snapshotHash) fail('WORLD_ASSET_NATIVE_BACKING_BINDING_REQUIRED')
      const offer = await client.readContract({ address: manifest.market, abi: assetMarketAbi, functionName: 'listings', args: [BigInt(row.tokenId)], blockNumber: BigInt(block.blockNumber) })
      const [seller, price, expiry, , , nonce] = Array.isArray(offer) ? offer : [offer.seller, offer.price, offer.expiry, offer.ownershipNonce, offer.revision, offer.nonce]
      const active = await client.readContract({ address: manifest.market, abi: assetMarketAbi, functionName: 'isListingActive', args: [BigInt(row.tokenId)], blockNumber: BigInt(block.blockNumber) })
      views.push(json({ tokenId: row.tokenId, kind: row.kind, parcelId: row.parcelId, descriptor: row.descriptor,
        ...(row.kind === 'item' ? { item: row.item || row.descriptor?.material || null, count: row.count ?? row.descriptor?.amount ?? 1 } : {}),
        owner: asset.owner, ownershipNonce: asset.ownershipNonce, revision: asset.revision, redemptionPending: asset.redemptionPending, redeemed: asset.redeemed,
        listing: { seller: lower(seller), priceBaseUnits: String(price), expiry: String(expiry), nonce: String(nonce), active: Boolean(active) } }))
    }
    await reader.unchanged(block)
    return { assets: views, blockNumber: String(block.blockNumber), blockHash: block.blockHash, confirmations: 2 }
  }
  async function receipts({ limit = 10 } = {}) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10) fail('WORLD_ASSET_RECEIPT_LIMIT_REQUIRED')
    const stages = { mint: 'register', snapshot: 'register', list: 'list', buy: 'buy', cancel: 'cancel', redeem: 'finalize-redemption' }
    const rows = (await store.list(deployment, 'operation:')).filter(row => row.status === 'complete' && row.stages?.[stages[row.action]]?.proof)
      .sort((a, b) => Number(BigInt(b.stages[stages[b.action]].proof.blockNumber) - BigInt(a.stages[stages[a.action]].proof.blockNumber))).slice(0, limit)
    const result = []
    for (const row of rows) {
      const stage = row.stages[stages[row.action]], proof = await reader.transaction({ transactionHash: stage.transactionHash,
        from: stage.from, to: stage.to, data: stage.data, eventName: stage.eventName, match: stage.proof.args })
      if (!proof.confirmed) continue
      result.push({ operationId: row.id, action: row.action, tokenId: row.tokenId || String(row.terms.asset?.tokenId), transactionHash: proof.transactionHash,
        blockNumber: proof.blockNumber, blockHash: proof.blockHash, confirmations: proof.confirmations, eventName: proof.eventName })
    }
    return result
  }
  return { preview, confirm, sync, reader, browse, receipts,
    async ownedAssets({ principalId }) { const owner = await actor(principalId), result = await browse(); return { ...result, assets: result.assets.filter(asset => asset.owner === owner.walletAddress) } },
    previewMint: request => preview({ ...request, action: 'mint' }), confirmMint: confirm,
    previewList: request => preview({ ...request, action: 'list' }), confirmList: confirm,
    previewBuy: request => preview({ ...request, action: 'buy' }), confirmBuy: confirm,
    previewCancel: request => preview({ ...request, action: 'cancel' }), confirmCancel: confirm,
    previewRedeem: request => preview({ ...request, action: 'redeem' }), confirmRedeem: confirm,
    previewSnapshot: request => preview({ ...request, action: 'snapshot' }), confirmSnapshot: confirm,
    async status({ principalId, operationId }) { return visible((await ownedRecord(principalId, operationId)).row) }
  }
}
