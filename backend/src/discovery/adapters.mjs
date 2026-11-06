import { ExpirationTime, jsonToPayload } from '@arkiv-network/sdk/utils'
import { and, eq } from '@arkiv-network/sdk/query'
import { keccak256, stringToHex } from 'viem'
import { discoveryTypedData } from './service.mjs'
import { hashTypedData } from 'viem'

function decode(entity) {
  if (entity.contentType !== 'application/json' || !(entity.payload instanceof Uint8Array) || entity.payload.byteLength > 65536) throw new Error('Unsupported discovery payload')
  return { key: entity.key, owner: entity.owner, envelope: JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(entity.payload)) }
}

export function createArkivDiscoveryAdapter({ publicClient, walletClient }) {
  const owner = walletClient?.account?.address?.toLowerCase()
  return {
    owner, fixture: false, provider: 'official-arkiv-sdk',
    async publish(envelope) {
      if (!walletClient) throw new Error('Arkiv signing account is required for publishing')
      if (await publicClient.getChainId() !== envelope.record.chainId) throw new Error('Arkiv network changed')
      const record = envelope.record
      const result = await walletClient.createEntity({ payload: jsonToPayload(envelope), contentType: 'application/json',
        attributes: { namespace: record.namespace, server_id: record.serverId, job_id: record.jobId, kind: record.kind, record_id: record.id, digest: hashTypedData(discoveryTypedData(record)) },
        expires: ExpirationTime.atDate(new Date(record.expiresAtMs)) })
      return { key: result.entityKey, transactionHash: result.txHash }
    },
    async get(key) { return decode(await publicClient.getEntity(key)) },
    async search(filters) {
      const attributeNames = { serverId: 'server_id', jobId: 'job_id', id: 'record_id' }
      const expressions = Object.entries(filters).filter(([, value]) => value !== undefined).map(([name, value]) => eq(attributeNames[name] || name, value))
      let page = await publicClient.select({ key: true, owner: true, payload: true, contentType: true }).where(and(...expressions)).limit(50).fetch()
      const entities = []
      while (true) {
        entities.push(...page.entities.map(entity => {
          try { return decode(entity) } catch { return { key: entity.key, owner: entity.owner, envelope: null } }
        }))
        if (!page.hasNextPage()) return entities
        if (entities.length >= 100) throw new Error('Discovery query exceeds the local MVP limit')
        page = await page.next()
      }
    }
  }
}

export function createLocalDiscoveryFixture({ store, owner }) {
  return {
    owner: owner.toLowerCase(), fixture: true, provider: 'postgresql-discovery-fixture',
    async publish(envelope) {
      const key = keccak256(stringToHex(JSON.stringify(envelope)))
      await store.query('INSERT INTO discovery_fixture_entities(entity_key,owner,envelope) VALUES($1,$2,$3) ON CONFLICT DO NOTHING', [key, owner.toLowerCase(), JSON.stringify(envelope)])
      return { key, transactionHash: null }
    },
    async get(key) {
      const row = (await store.query('SELECT * FROM discovery_fixture_entities WHERE entity_key=$1', [key])).rows[0]
      if (!row) throw new Error('Fixture entity not found')
      return { key: row.entity_key, owner: row.owner, envelope: row.envelope }
    },
    async search(filters) {
      const { rows } = await store.query('SELECT * FROM discovery_fixture_entities WHERE envelope->\'record\'->>\'namespace\'=$1', [filters.namespace])
      return rows.filter(row => Object.entries(filters).every(([name, value]) => value === undefined || row.envelope.record[name] === value))
        .map(row => ({ key: row.entity_key, owner: row.owner, envelope: row.envelope }))
    }
  }
}
