import {setTimeout as sleep} from 'node:timers/promises'

const safeCode = error => /^[A-Za-z0-9_]+$/.test(error.code || error.message || '')
  ? (error.code || error.message).toUpperCase() : 'POOL_OBSERVATION_UNAVAILABLE'
const terminal = code => /BUDGET|CAP|CODE_CHANGED|CHAIN_CHANGED|GENESIS_CHANGED|BINDING_CHANGED|CONFIGURATION|SIGNER|DENIED|REORG|PRIVATE_FILE|ENOENT|DELEGATION_EXPIRED/.test(code)

/** Maintain real pool history; publish() retains the existing signed intent after an uncertain reply. */
export function createPoolObservationKeeper({publish, acquireLease, record, pause = sleep}) {
  let job, controller, state = {status: 'stopped'}
  const save = async value => { state = {...state, ...value, updatedAt: new Date().toISOString()}; await record(state) }

  function start() {
    if (job) return {started: false, status: state.status}
    controller = new AbortController()
    const signal = controller.signal
    job = (async () => {
      let release
      try {
        while (!signal.aborted) {
          try {
            release ||= await acquireLease()
            if (signal.aborted) break
            const result = await publish()
            await save({status: result.pending ? 'pending' : 'running', error: null,
              transactionHash: result.proof?.transactionHash || result.proof?.hash || null})
          } catch (error) {
            const code = safeCode(error)
            await save({status: terminal(code) ? 'blocked' : code === 'EADDRINUSE' ? 'waiting_for_keeper' : 'retrying', error: code})
            if (terminal(code)) return
          }
          await pause(30000, undefined, {signal})
        }
      } catch (error) {
        if (!signal.aborted) {
          state = {...state, status: 'blocked', error: safeCode(error)}
          await record(state).catch(() => {})
        }
      } finally {
        await release?.()
      }
    })()
    return {started: true}
  }

  return {start, status: () => structuredClone(state), async stop() {
    controller?.abort()
    await job
    job = undefined
  }}
}
