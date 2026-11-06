import { runContractDemo } from '../backend/src/workflow/contract-demo.mjs'

const args = process.argv.slice(2)
if (args.some(argument => argument !== '--public-testnet') || args.length > 1) throw new Error('unsupported_demo_argument')
await runContractDemo({ publicTestnet: args.includes('--public-testnet') })
