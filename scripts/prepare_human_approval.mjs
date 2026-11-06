import { prepareHumanReview } from '../backend/src/identity/human-review.mjs'

const options = process.argv.slice(2), argumentsFor = new Map()
let checkOnly = false
for (let index = 0; index < options.length; index++) {
  const option = options[index]
  if (option === '--check') { checkOnly = true; continue }
  if (!['--requester', '--builder'].includes(option) || argumentsFor.has(option) || !options[index + 1]) throw new Error('usage: --builder ADDRESS [--requester ADDRESS] [--check]')
  argumentsFor.set(option, options[++index])
}
if (!argumentsFor.has('--builder')) throw new Error('builder_public_address_required')
const result = await prepareHumanReview({ requester: argumentsFor.get('--requester'), builder: argumentsFor.get('--builder'), checkOnly })
const { links, ...summary } = result
console.log(JSON.stringify(summary))
