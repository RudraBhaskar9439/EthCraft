import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { http } from 'viem'
import { openDevelopmentKeystore } from '../chain/development-wallets.mjs'
import checkpoints from '../bot/checkpoint-store.cjs'
import { createTaskReader, TaskPublisher, loadPublisherState, serverNamespace, projectProgress, publisherAddress } from './tasks.mjs'

export async function openTaskBoard(root, { writer = false } = {}) {
  const settings = JSON.parse(await readFile(join(root,'.local/arkiv/settings.json'),'utf8'))
  const active = JSON.parse(await readFile(join(root,'.local/playable-world/active.json'),'utf8'))
  if (settings.version !== 1 || settings.server !== serverNamespace(active.serverId) || settings.publisher.toLowerCase() !== publisherAddress.toLowerCase()) throw Error('ARKIV_DEPLOYMENT_BINDING_REQUIRED')
  const reader = createTaskReader(settings)
  if (!writer) return reader
  const release = await checkpoints.acquireLocalLease('arkiv-publisher:' + root)
  try {
    const accounts = JSON.parse(await readFile(join(root,'.local/public-testnet/accounts.json'),'utf8'))
    const account = await openDevelopmentKeystore(accounts.publisher)
    if (account.address.toLowerCase() !== settings.publisher.toLowerCase()) throw Error('ARKIV_PUBLISHER_BINDING_REQUIRED')
    const file = join(root,'.local/arkiv/publications.json')
    const publisher = new TaskPublisher({reader,account,file,state:await loadPublisherState(file,settings.server,settings.publisher),
      transport:http(reader.client.chain.rpcUrls.default.http[0],{retryCount:0,timeout:20000})})
    const handoffs = new Set()
    const queued = new Map(publisher.state.entries.filter(e => !['confirmed','reverted'].includes(e.status)).map(e => [e.record.job,e.record]))
    let tail = Promise.resolve(), closed = false
    const flush = () => {
      const work = tail.then(async () => {
        if (closed) return
        for (const [key,record] of queued) {
          try { await publisher.publish(record); if (queued.get(key) === record) queued.delete(key) }
          catch (error) {
            if (error.message === 'ARKIV_SHARED_RECORD_EXPIRED') { if (queued.get(key) === record) queued.delete(key); continue }
            console.warn('Arkiv progress waiting:', safeError(error)); break
          }
        }
      })
      tail = work.catch(() => {}); return work
    }
    const timer = setInterval(flush,60000)
    timer.unref()
    return {
      ...reader, publisher,
      onProgress(provider, job) {
        if (!job?.arkivShared || closed) return
        queued.set(job.id,projectProgress(job,provider,settings.server)); void flush()
      },
      async share(provider, survival, ownerId) {
        const job = survival.latest(ownerId)
        if (!job) return 'Start a task first. Publishing exposes only action facts and block positions, never your prompt or identity.'
        job.arkivShared = true; await survival.save()
        const result = await publisher.publish(projectProgress(job,provider,settings.server))
        return 'Progress published on Arkiv Rabdi: '+result.entityKey+'. Public action facts and block positions only. Use /agent '+(provider==='claude'?'agent':'0g')+' unshare to stop future updates.'
      },
      async unshare(survival, ownerId) {
        const job = survival.latest(ownerId)
        if (!job) return 'No task to unshare.'
        job.arkivShared = false; queued.delete(job.id); await survival.save(); await tail
        return 'Future progress sharing stopped. Already submitted public records remain until expiry or publisher deletion.'
      },
      async handoff(input) {
        if (handoffs.has(input.event.playerId)) return 'A handoff is already being reconciled. Wait for its result.'
        handoffs.add(input.event.playerId)
        try { return await handoffTask({...input,publisher,reader,server:settings.server,onProgress:this.onProgress}) }
        finally { handoffs.delete(input.event.playerId) }
      },
      async close() { closed = true; clearInterval(timer); await tail; await publisher.tail; await release() }
    }
  } catch (error) { await release(); throw error }
}

export async function handoffTask({provider, objectives, event, jobId, publisher, reader, server, onProgress}) {
        const existing = objectives[provider].state.jobs.find(j => j.operationId === event.operationId && j.ownerId === event.playerId)
        if (existing?.sharedProgress) return objectives[provider].status(event.playerId)
        const source = Object.entries(objectives).find(([p,o]) => p !== provider && o.state.jobs.some(j => j.id === jobId && j.ownerId === event.playerId))
        if (!source) throw Error('ARKIV_OWNED_SOURCE_TASK_REQUIRED')
        const [sourceProvider, survival] = source, job = survival.latest(event.playerId)
        if (job?.id !== jobId || !job.arkivShared) throw Error('ARKIV_CURRENT_SHARED_TASK_REQUIRED')
        const target = objectives[provider]
        if (job.handoffIntent) {
          const prior = target.state.jobs.find(j => j.operationId === job.handoffIntent.operationId && j.ownerId === event.playerId)
          if (prior?.sharedProgress) { job.status = 'handed_off'; await survival.save(); return target.status(event.playerId) }
          delete job.handoffIntent; await survival.save()
        }
        if (job.status === 'handed_off') throw Error('ARKIV_TASK_ALREADY_HANDED_OFF')
        const previous = target.latest(event.playerId)
        if (target.running.has(event.playerId) || previous?.status === 'running' || previous?.pendingEffect) throw Error('ARKIV_TARGET_TASK_MUST_BE_IDLE')
        if (job.pendingEffect || survival.manager?.tools?.unfinished(event.playerId)) throw Error('ARKIV_PENDING_EFFECT_BLOCKS_HANDOFF')
        job.handoffIntent = { operationId:event.operationId, provider }; await survival.save()
        await survival.stop(event.playerId); await survival.running.get(event.playerId)
        if (job.pendingEffect || job.activeLock || survival.manager?.tools?.unfinished(event.playerId)) { delete job.handoffIntent; await survival.save(); throw Error('ARKIV_PENDING_EFFECT_BLOCKS_HANDOFF') }
        if (job.status !== 'paused') { job.status = 'paused'; await survival.save() }
        try {
        const published = await publisher.publish(projectProgress(job,sourceProvider,server))
        // Read through Arkiv again: local journals authorize work; shared data supplies only observed context.
        const observed = await reader.get(published.entityKey)
        if (observed.job !== job.id || observed.facts.pendingEffect || observed.status !== 'paused') throw Error('ARKIV_SAFE_HANDOFF_REQUIRED')
        const context = { entityKey: observed.entityKey, rootTask: observed.task, provider: sourceProvider, facts: observed.facts }
        const result = await target.start(event,job.goal,context)
        if (target.latest(event.playerId)?.sharedProgress?.entityKey !== observed.entityKey) { delete job.handoffIntent; await survival.save(); return result }
        job.status = 'handed_off'; job.message = 'Owner requested continuation by the other agent; Arkiv progress is advisory.'
        await survival.save(); onProgress(sourceProvider,job)
        return result+' Arkiv handoff read: '+observed.entityKey+'. Supplies and world state are rechecked; permissions are not transferred.'
        } catch (error) {
          if (!target.state.jobs.some(j => j.operationId === event.operationId && j.ownerId === event.playerId)) { delete job.handoffIntent; await survival.save() }
          throw error
        }
}

export const safeError = error => /^[A-Z0-9_]+$/.test(error.code || error.message || '') ? error.code || error.message : 'ARKIV_RPC_UNAVAILABLE'
