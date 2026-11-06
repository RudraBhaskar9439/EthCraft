import { createServer } from 'node:http'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { openWalletHandoffs } from './identity/http-runtime.mjs'
import { prepareHumanReview } from './identity/human-review.mjs'
import { handleHumanSession } from './workflow/human-session.mjs'
import { openPlayerWalletAuth, playerWalletPublicConfig } from './playable/wallet-http-runtime.mjs'
import { openDiscordIdentityRuntime, discordPublicConfig } from './discord/runtime.mjs'
import { openInventoryShopRuntime } from './playable/inventory-shop-runtime.mjs'
import { openTaskBoard, safeError as arkivError } from './arkiv/runtime.mjs'

const root = new URL('../../', import.meta.url)
const port = Number(process.env.AGENTCITY_LOCAL_PORT || 8789)
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('invalid_local_port')
const origin = `http://127.0.0.1:${port}`
const playerOrigin=(await playerWalletPublicConfig()).origin||origin
const discordOrigin=(await discordPublicConfig()).origin||origin
const token = randomBytes(32).toString('hex')
let running = false
let lastRunError = null
let walletRuntime
let playerWalletRuntime
let discordRuntime
let inventoryRuntime
let taskBoardRuntime
const taskBoard = async () => taskBoardRuntime || (taskBoardRuntime = openTaskBoard(fileURLToPath(root)).catch(error => { taskBoardRuntime = null; throw error }))
const inventoryShop=async()=>inventoryRuntime||(inventoryRuntime=discordIdentity().then(identityRuntime=>openInventoryShopRuntime({rootDirectory:fileURLToPath(root),identityRuntime})).catch(error=>{inventoryRuntime=null;throw error}))
const discordIdentity=async()=>{
  if(!discordRuntime)discordRuntime=openDiscordIdentityRuntime().catch(error=>{discordRuntime=null;throw error})
  return discordRuntime
}
const playerWalletAuth=async()=>{
  if(!playerWalletRuntime)playerWalletRuntime=openPlayerWalletAuth({origin:playerOrigin}).catch(error=>{playerWalletRuntime=null;throw error})
  return playerWalletRuntime
}
const handoffs = async () => {
  if (!walletRuntime) walletRuntime = openWalletHandoffs(origin).catch(error => { walletRuntime = null; throw error })
  return (await walletRuntime).service
}
const jsonFile = async path => {
  try { return JSON.parse(await readFile(new URL(path, root), 'utf8')) }
  catch (error) { if (error.code === 'ENOENT') return null; throw error }
}
const latest = async path => {
  const pointer = await jsonFile(path)
  return pointer ? JSON.parse(await readFile(pointer.report, 'utf8')) : null
}
const commands = {
  '/api/demo': ['scripts/local_demo.mjs'],
  '/api/public-demo': ['scripts/local_demo.mjs', '--public-testnet'],
  '/api/public-resume': ['scripts/resume_local_settlement.mjs', '--public-testnet']
}
const assets = {
  '/arkiv.mjs': ['backend/src/web/arkiv.mjs', 'text/javascript; charset=utf-8'],
  '/arkiv.css': ['backend/src/web/arkiv.css', 'text/css; charset=utf-8'],
  '/console.mjs': ['backend/src/web/console.mjs', 'text/javascript; charset=utf-8'],
  '/console.css': ['backend/src/web/console.css', 'text/css; charset=utf-8']
}
for (const page of ['wallet', 'human']) for (const [extension, contentType] of [['mjs', 'text/javascript; charset=utf-8'], ['css', 'text/css; charset=utf-8']]) assets['/' + page + '.' + extension] = ['backend/src/web/' + page + '.' + extension, contentType]
const humanActions = new Set(['start', 'identity', 'register', 'prepare', 'begin', 'submitted', 'reconcile', 'rejected', 'provision', 'publish', 'advance'])
const humanResponse = (response, status, result) => response.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(result))
const humanFailure = (response, error) => humanResponse(response, 409, { error: /^[A-Z][A-Z_]+$/.test(error.code || '') ? error.code : 'HUMAN_SERVICE_UNAVAILABLE' })

createServer(async (request, response) => {
  response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; frame-ancestors 'none'; base-uri 'none'; object-src 'none'")
  response.setHeader('Cache-Control', 'no-store')
  response.setHeader('X-Content-Type-Options', 'nosniff')
  response.setHeader('Referrer-Policy', 'no-referrer')
  let onboardingPage=null
  try { const pathname=new URL(request.url,'http://127.0.0.1').pathname; if(['/discord/setup','/player-wallet','/inventory-shop/checkout'].includes(pathname)&&request.url.split('?')[0]===pathname)onboardingPage=pathname } catch { response.writeHead(400).end();return }
  const playerPath=onboardingPage==='/player-wallet'||['/player-wallet','/player-wallet.js','/player-wallet.js.LEGAL.txt','/api/player-wallet/config','/api/player-wallet/link'].includes(request.url)
  const discordPath=onboardingPage==='/discord/setup'||['/discord/setup','/discord-setup.js','/discord-setup.js.LEGAL.txt','/api/discord/config','/api/discord/complete','/api/discord/wallet'].includes(request.url)
  if (request.headers.host !== `127.0.0.1:${port}` && !(playerPath&&request.headers.host===new URL(playerOrigin).host) && !(discordPath&&request.headers.host===new URL(discordOrigin).host)) { response.writeHead(403).end(); return }
  try {
    if (request.method === 'GET' && request.url === '/arkiv') {
      response.setHeader('Content-Type','text/html; charset=utf-8')
      response.end(await readFile(new URL('backend/src/web/arkiv.html',root))); return
    }
    if (request.method === 'GET' && request.url.split('?')[0] === '/api/arkiv/tasks') {
      try {
        const parameters = new URL(request.url,origin).searchParams
        if ([...parameters.keys()].some(k => !['provider','status','offset'].includes(k) || parameters.getAll(k).length !== 1)) throw Error('ARKIV_QUERY_INVALID')
        const filters = Object.fromEntries(parameters)
        if (filters.offset !== undefined) filters.offset = Number(filters.offset)
        humanResponse(response,200,await (await taskBoard()).list(filters))
      } catch (error) { humanResponse(response,503,{error:arkivError(error),source:'unavailable',records:[]}) }
      return
    }
    const agentAction=request.url.match(/^\/api\/agent-shop\/(purchase|revoke)$/)
    if(request.method==='POST'&&agentAction){
      if(request.headers.origin||request.headers['content-type']!=='application/json'){humanResponse(response,403,{error:'AGENT_SHOP_PRIVATE_CLIENT_REQUIRED'});return}
      const runtime=await inventoryShop()
      if(!runtime.authenticateAgent(request.headers.authorization)){humanResponse(response,403,{error:'AGENT_SHOP_PRIVATE_CLIENT_REQUIRED'});return}
      let size=0;const chunks=[]
      for await(const chunk of request){size+=chunk.length;if(size>2048){humanResponse(response,413,{error:'AGENT_SHOP_REQUEST_TOO_LARGE'});return}chunks.push(chunk)}
      try{
        if(!runtime.agentShop)throw Error('AGENT_SHOP_NOT_ENABLED')
        humanResponse(response,200,await runtime.agentShop[agentAction[1]](JSON.parse(Buffer.concat(chunks).toString('utf8'))))
      }catch(error){humanResponse(response,409,{error:/^[A-Z0-9_]+$/.test(error.code||error.message||'')?error.code||error.message:'AGENT_SHOP_UNAVAILABLE'})}
      return
    }
    if(request.method==='GET'&&(onboardingPage==='/inventory-shop/checkout'||['/inventory-shop-checkout.js','/inventory-shop-checkout.js.LEGAL.txt'].includes(request.url))){
      response.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self' https://challenges.cloudflare.com; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; frame-src https://auth.privy.io https://challenges.cloudflare.com; connect-src 'self' https://auth.privy.io; frame-ancestors 'none'; base-uri 'none'; object-src 'none'")
      const page=onboardingPage==='/inventory-shop/checkout',asset=page?'companion/inventory-shop-checkout.html':'companion/dist/'+request.url.slice(1)
      response.setHeader('Content-Type',page?'text/html; charset=utf-8':request.url.endsWith('.txt')?'text/plain; charset=utf-8':'text/javascript; charset=utf-8')
      response.end(await readFile(new URL(asset,root)));return
    }
    const shopAction=request.url.match(/^\/api\/inventory-shop-checkout\/(state|challenge|link|fund|prepare|buy|redeem|submitted|unknown|rejected|cancel|claim)$/)
    if(request.method==='POST'&&shopAction){
      if(request.headers.origin!==origin||request.headers['content-type']!=='application/json'){humanResponse(response,403,{error:'INVENTORY_SHOP_ORIGIN_REQUIRED'});return}
      let size=0;const chunks=[];for await(const chunk of request){size+=chunk.length;if(size>20000){humanResponse(response,413,{error:'INVENTORY_SHOP_REQUEST_TOO_LARGE'});return}chunks.push(chunk)}
      try{
        const input=JSON.parse(Buffer.concat(chunks).toString('utf8'))
        const extra={challenge:['address'],link:['address','signature'],submitted:['operationId','transactionHash'],unknown:['operationId'],rejected:['operationId']}[shopAction[1]]||[]
        if(!input||Array.isArray(input)||typeof input!=='object'||Object.keys(input).some(key=>!['request','accessToken',...extra].includes(key)))throw Error('INVENTORY_SHOP_FIELDS_REQUIRED')
        humanResponse(response,200,await(await inventoryShop()).checkout[shopAction[1]](input))
      }catch(error){humanResponse(response,409,{error:/^[A-Z0-9_]+$/.test(error.code||error.message||'')?(error.code||error.message):'INVENTORY_SHOP_STEP_UNAVAILABLE',message:'This purchase step is waiting. Keep the original order and transaction; no replacement payment is needed.'})}
      return
    }
    if(request.method==='GET'&&request.url==='/api/discord/config'){humanResponse(response,200,await discordPublicConfig());return}
    if(request.method==='GET'&&(onboardingPage==='/discord/setup'||['/discord-setup.js','/discord-setup.js.LEGAL.txt'].includes(request.url))){
      response.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self' https://challenges.cloudflare.com; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; frame-src https://auth.privy.io https://challenges.cloudflare.com; child-src https://auth.privy.io https://challenges.cloudflare.com; connect-src 'self' https://auth.privy.io; frame-ancestors 'none'; base-uri 'none'; object-src 'none'")
      const asset=onboardingPage==='/discord/setup'?'companion/discord-setup.html':'companion/dist/'+request.url.slice(1)
      response.setHeader('Content-Type',onboardingPage==='/discord/setup'?'text/html; charset=utf-8':request.url.endsWith('.txt')?'text/plain; charset=utf-8':'text/javascript; charset=utf-8')
      try{response.end(await readFile(new URL(asset,root)))}catch(error){if(error.code!=='ENOENT')throw error;response.writeHead(503).end('Discord setup is being prepared.')}
      return
    }
    if(request.method==='POST'&&['/api/discord/complete','/api/discord/wallet'].includes(request.url)){
      if(request.headers.origin!==discordOrigin||request.headers['content-type']!=='application/json'){humanResponse(response,403,{error:'DISCORD_SETUP_ORIGIN_REQUIRED'});return}
      let size=0;const chunks=[];for await(const chunk of request){size+=chunk.length;if(size>16384){humanResponse(response,413,{error:'DISCORD_SETUP_REQUEST_TOO_LARGE'});return}chunks.push(chunk)}
      try{
        const input=JSON.parse(Buffer.concat(chunks).toString('utf8')),wallet=request.url.endsWith('/wallet')
        if(!input||Array.isArray(input)||Object.keys(input).some(key=>!(wallet?['accessToken']:['accessToken','challenge']).includes(key))||typeof input.accessToken!=='string')throw Error('DISCORD_SETUP_FIELDS_REQUIRED')
        const runtime=await discordIdentity()
        humanResponse(response,200,wallet?await runtime.walletForAccessToken(input.accessToken):await runtime.service.completeSetup(input))
      }catch(error){
        const code=/^[A-Z][A-Z_]+$/.test(error.code||error.message||'')?(error.code||error.message):'DISCORD_SETUP_UNAVAILABLE'
        console.warn('Discord setup refused:',code)
        humanResponse(response,409,{error:code})
      }
      return
    }
    if(request.method==='GET'&&request.url==='/api/player-wallet/config') {
      humanResponse(response,200,await playerWalletPublicConfig());return
    }
    if(request.method==='GET'&&(onboardingPage==='/player-wallet'||['/player-wallet.js','/player-wallet.js.LEGAL.txt'].includes(request.url))) {
      response.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self' https://challenges.cloudflare.com; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; frame-src https://auth.privy.io https://challenges.cloudflare.com; child-src https://auth.privy.io https://challenges.cloudflare.com; connect-src 'self' https://auth.privy.io; frame-ancestors 'none'; base-uri 'none'; object-src 'none'")
      const asset=onboardingPage==='/player-wallet'?'companion/player-wallet.html':'companion/dist/'+request.url.slice(1)
      response.setHeader('Content-Type',onboardingPage==='/player-wallet'?'text/html; charset=utf-8':request.url.endsWith('.txt')?'text/plain; charset=utf-8':'text/javascript; charset=utf-8')
      try {response.end(await readFile(new URL(asset,root)))}
      catch(error){if(error.code!=='ENOENT')throw error;response.writeHead(503).end('Player wallet login is being prepared. Ask the local operator to build the companion app.')}
      return
    }
    if(request.method==='POST'&&request.url==='/api/player-wallet/link') {
      if(request.headers.origin!==playerOrigin||request.headers['content-type']!=='application/json'){humanResponse(response,403,{error:'WALLET_ORIGIN_REQUIRED'});return}
      let size=0;const chunks=[]
      for await(const chunk of request){size+=chunk.length;if(size>16384){humanResponse(response,413,{error:'WALLET_REQUEST_TOO_LARGE'});return}chunks.push(chunk)}
      try {
        const input=JSON.parse(Buffer.concat(chunks).toString('utf8'))
        if(!input||Array.isArray(input)||Object.keys(input).some(key=>!['challenge','accessToken'].includes(key)))throw Error('WALLET_LINK_FIELDS')
        humanResponse(response,200,await(await playerWalletAuth()).complete(input))
      }catch(error){humanResponse(response,409,{error:/^[A-Z][A-Z_]+$/.test(error.code||error.message||'')?(error.code||error.message):'WALLET_LINK_UNAVAILABLE'})}
      return
    }
    if (request.method === 'GET' && request.url === '/wallet') {
      response.setHeader('Content-Type', 'text/html; charset=utf-8')
      response.end(await readFile(new URL('backend/src/web/wallet.html', root))); return
    }
    const handoff = request.url.match(/^\/api\/wallet\/handoffs\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(\/signature)?$/i)
    if (handoff && (request.method === 'GET' && !handoff[2] || request.method === 'POST' && handoff[2])) {
      if (request.method === 'POST' && (request.headers.origin !== origin || request.headers['content-type'] !== 'application/json')) { response.writeHead(403).end(); return }
      try {
        const capability = String(request.headers['x-agentcity-handoff'] || '')
        let input
        if (request.method === 'POST') {
          const chunks = []
          let size = 0
          for await (const chunk of request) { size += chunk.length; if (size > 4096) { response.writeHead(413).end(); return }; chunks.push(chunk) }
          input = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        }
        const service = await handoffs()
        const result = request.method === 'GET' ? await service.get(handoff[1], capability) : await service.submit(handoff[1], capability, input)
        response.setHeader('Content-Type', 'application/json')
        response.end(JSON.stringify(result)); return
      } catch { response.writeHead(400, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: 'Approval request unavailable or verification rejected.' })); return }
    }
    if (request.method === 'GET' && ['/', '/human'].includes(request.url)) {
      const html = await readFile(new URL('backend/src/web/' + (request.url === '/human' ? 'human' : 'console') + '.html', root), 'utf8')
      response.setHeader('Content-Type', 'text/html; charset=utf-8')
      response.end(html.replace('{{LOCAL_TOKEN}}', token)); return
    }
    if (request.method === 'GET' && assets[request.url]) {
      const [path, contentType] = assets[request.url]
      response.setHeader('Content-Type', contentType)
      response.end(await readFile(new URL(path, root))); return
    }
    if (request.method === 'GET' && request.url === '/api/human/status') {
      try { humanResponse(response, 200, await handleHumanSession({ action: 'status', origin })) }
      catch (error) { humanFailure(response, error) }
      return
    }
    if (request.method === 'GET' && request.url === '/api/status') {
      const [result, publicResult, minecraft, recovery, maintainedMinecraft] = await Promise.all([
        latest('.local/backend/latest-demo.json'), latest('.local/public-testnet/latest-demo.json'),
        jsonFile('evidence/runs/minecraft-internal/verification.json'), jsonFile('evidence/RECOVERY_CHECKPOINT.json'),
        jsonFile('evidence/MAINTAINED_RUNTIME.json')
      ])
      response.setHeader('Content-Type', 'application/json')
      response.end(JSON.stringify({ running, lastRunError, result, publicResult, minecraft, recovery, maintainedMinecraft, liveGatesPassed: false })); return
    }
    const humanAction = request.url.startsWith('/api/human/') ? request.url.slice('/api/human/'.length) : null
    if (request.method === 'POST' && (commands[request.url] || request.url === '/api/human-review' || humanActions.has(humanAction))) {
      const supplied = Buffer.from(String(request.headers['x-agentcity-local'] || ''))
      if ((request.headers.origin && request.headers.origin !== origin) || supplied.length !== token.length || !timingSafeEqual(supplied, Buffer.from(token)) || request.headers['content-type'] !== 'application/json') { response.writeHead(403).end(); return }
      if (running) { humanResponse(response, 409, { error: 'LOCAL_OPERATION_RUNNING' }); return }
      let size = 0
      const chunks = []
      for await (const chunk of request) { size += chunk.length; if (size > 1024) { response.writeHead(413).end(); return }; chunks.push(chunk) }
      if (humanActions.has(humanAction)) {
        let input
        try { input = JSON.parse(Buffer.concat(chunks).toString('utf8')) }
        catch { humanResponse(response, 400, { error: 'HUMAN_SESSION_ACTION_FIELDS' }); return }
        running = true
        try { humanResponse(response, 200, await handleHumanSession({ action: humanAction, input, origin })) }
        catch (error) { humanFailure(response, error) }
        finally { running = false }
        return
      }
      if (request.url === '/api/human-review') {
        const input = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
        if (!input || Array.isArray(input) || Object.keys(input).length) { response.writeHead(400).end(); return }
        const participants = await jsonFile('.local/human-approvals/participants.json')
        if (!participants?.requester || !participants?.builder) { response.writeHead(409).end('Participant addresses are not prepared.'); return }
        running = true
        try {
          const { privateDirectory, ...review } = await prepareHumanReview({ requester: participants.requester, builder: participants.builder, origin, reuseActive: true })
          response.setHeader('Content-Type', 'application/json')
          response.end(JSON.stringify(review)); return
        } finally { running = false }
      }
      const [script, ...args] = commands[request.url]
      running = true
      lastRunError = null
      const child = spawn(process.execPath, [fileURLToPath(new URL(script, root)), ...args], { cwd: fileURLToPath(root), stdio: 'inherit' })
      child.once('exit', code => { running = false; if (code !== 0) lastRunError = 'The last attempt stopped. Its report is retained for recovery.' })
      child.once('error', () => { running = false; lastRunError = 'The local process could not start.' })
      response.writeHead(202).end('{}'); return
    }
    response.writeHead(404).end()
  } catch { response.writeHead(500).end('Local service error') }
}).listen(port, '127.0.0.1', () => {
  console.log('AgentCity laptop console: ' + origin)
  void jsonFile('.local/mumbai-city/shop-settings.json').then(settings=>settings?.enabled===true?inventoryShop().then(runtime=>runtime.start()):null)
    .catch(error=>console.error('Inventory marketplace is waiting:',/^[A-Z0-9_]+$/.test(error.code||error.message||'')?error.code||error.message:'INVENTORY_SHOP_STARTUP_UNAVAILABLE'))
})
