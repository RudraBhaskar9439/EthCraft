import React,{useEffect,useState} from 'react'
import {createRoot} from 'react-dom/client'
import {PrivyProvider,usePrivy} from '@privy-io/react-auth'
import {checkoutStep,checkoutError} from './inventory-shop-flow.mjs'

const storageKey='agentcity-inventory-shop-checkout'
const fresh=new URLSearchParams(location.hash.slice(1)).get('request')
let saved
try{saved=JSON.parse(sessionStorage.getItem(storageKey)||'null');if(saved?.expiresAtMs<=Date.now()){sessionStorage.removeItem(storageKey);saved=null}}catch{}
const request=/^[A-Za-z0-9_-]{43}$/.test(fresh||'')?fresh:saved?.expiresAtMs>Date.now()?saved.request:null
const expiresAtMs=fresh===request?Date.now()+600000:saved?.expiresAtMs||0
if(request)try{sessionStorage.setItem(storageKey,JSON.stringify({request,expiresAtMs}))}catch{}
history.replaceState(null,'',location.pathname+location.search)
const hex=text=>'0x'+Array.from(new TextEncoder().encode(text),byte=>byte.toString(16).padStart(2,'0')).join('')
const label=value=>String(value||'').replaceAll('_',' ')
function Checkout(){
  const {ready,authenticated,login,logout,getAccessToken}=usePrivy()
  const [order,setOrder]=useState(null),[busy,setBusy]=useState(false),[message,setMessage]=useState('')
  const [reportedHash,setReportedHash]=useState('')
  function clearRequest(){try{if(JSON.parse(sessionStorage.getItem(storageKey)||'null')?.request===request)sessionStorage.removeItem(storageKey)}catch{}}
  useEffect(()=>{if(!request)return;const timer=setTimeout(clearRequest,Math.max(0,expiresAtMs-Date.now()));return()=>clearTimeout(timer)},[])
  async function api(action,fields={}){
    if(!request)throw Error('Open the original UniRock checkout link from Minecraft. Its short-lived browser session expired; the original order remains retained.')
    const accessToken=await getAccessToken()
    if(!accessToken)throw Error('Sign in with the same Discord/Privy account used in Minecraft.')
    const response=await fetch('/api/inventory-shop-checkout/'+action,{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify({request,accessToken,...fields})})
    const result=await response.json()
    if(!response.ok)throw Error(checkoutError(result.error,result.message))
    return result
  }
  async function refresh(){const state=await api('state');setOrder(state);if(state.delivered||state.cancelled)clearRequest();return state}
  useEffect(()=>{if(authenticated&&request)refresh().catch(error=>setMessage(error.message))},[authenticated])
  async function run(action,fields={}){
    setBusy(true)
    try{const result=await api(action,fields);await refresh();setMessage(action==='fund'?'Grant request checked. Its current status is shown below.':action==='state'?'Order updated. Continue with the step below.':result.message||'Step recorded. Continue with the step below.')}
    catch(error){setMessage(error.message)}finally{setBusy(false)}
  }
  async function wallet(){
    const provider=window.ethereum
    if(!provider?.request)throw Error('Open this page in the browser where your MetaMask or other Ethereum wallet is installed.')
    const accounts=await provider.request({method:'eth_requestAccounts'})
    if(accounts[0]?.toLowerCase()!==order?.expectedWallet?.toLowerCase())throw Error('Select your designated wallet '+order.expectedWallet+' in the wallet extension.')
    return{provider,address:accounts[0]}
  }
  async function link(){
    setBusy(true)
    try{
      const {provider,address}=await wallet(),challenge=await api('challenge',{address})
      const signature=await provider.request({method:'personal_sign',params:[hex(challenge.message),address]})
      await api('link',{address,signature});setMessage('Your wallet ownership is verified. This signature authorized no payment.');await refresh()
    }catch(error){setMessage(error.message)}finally{setBusy(false)}
  }
  async function sign(){
    const transaction=order?.transaction
    if(!transaction||transaction.unknown_outcome)return
    setBusy(true);let sending=false
    try{
      const {provider}=await wallet()
      if(await provider.request({method:'eth_chainId'})!=='0x515')await provider.request({method:'wallet_switchEthereumChain',params:[{chainId:'0x515'}]})
      // Fence another tab or a reload before the wallet prompt can broadcast.
      await api('unknown',{operationId:transaction.operation_id})
      sending=true
      const transactionHash=await provider.request({method:'eth_sendTransaction',params:[transaction.request]})
      setReportedHash(transactionHash)
      await api('submitted',{operationId:transaction.operation_id,transactionHash})
      setMessage('Transaction hash recorded. Continue the same step after two chain confirmations. Do not send it again.');await refresh()
    }catch(error){
      if(sending&&error.code!==4001){setMessage('The wallet reply is uncertain. Do not send again. Find the original transaction hash in your wallet and record it below.');await refresh().catch(()=>{})}
      else if(sending&&error.code===4001){
        try{await api('rejected',{operationId:transaction.operation_id});setMessage('Wallet request rejected. Your original unsigned order remains available.')}
        catch{setMessage('The wallet rejected this request, but server acknowledgement is pending. Refresh the original order before retrying.')}
        await refresh().catch(()=>{})
      }
      else{setMessage(error.message);await refresh().catch(()=>{})}
    }finally{setBusy(false)}
  }
  const next=checkoutStep(order),steps=['Account','Wallet','Payment','Collect']
  const recover=<div className="recovery"><label htmlFor="txhash">Original transaction hash</label><p className="muted">Copy the hash from your wallet’s activity. This checks the existing transaction without sending it again.</p><input id="txhash" value={reportedHash} onChange={event=>setReportedHash(event.target.value.trim())} placeholder="0x…" autoComplete="off" spellCheck="false"/>
    <button className="secondary" disabled={busy||!/^0x[0-9a-f]{64}$/i.test(reportedHash)} onClick={()=>run('submitted',{operationId:order.transaction.operation_id,transactionHash:reportedHash})}>Check original transaction</button></div>
  return <main className="checkout-shell">
    <header className="brand"><span className="brand-mark" aria-hidden="true">U</span><span>UniRock <small>AGENTCITY · MUMBAI</small></span><span className="test-badge">TESTNET</span></header>
    <div className="page-heading"><p className="eyebrow">MATERIAL MARKETPLACE</p><h1>A few steps to your next build.</h1><p className="muted">Pay with CITY. Collect your materials in Minecraft.</p></div>
    <ol className="steps" aria-label="Checkout progress">{steps.map((text,index)=><li key={text} className={index<next.step?'done':index===next.step?'current':''} aria-current={index===next.step?'step':undefined}><span>{index<next.step?'✓':index+1}</span>{text}</li>)}</ol>
    <div className="checkout-layout"><section className="card action-card" aria-labelledby="step-title">
      <p className="eyebrow">{order?.delivered?'PURCHASE COMPLETE':`STEP ${Math.min(next.step+1,4)} OF 4`}</p><h2 id="step-title">{next.title}</h2><p className="description">{next.description}</p>
      {!request?<div className="notice" role="alert">Open your checkout link from Minecraft. Use /market to select your materials and review the order.</div>:<>
        {message&&<p className="notice" role="status" aria-live="polite">{message}</p>}
        {!ready&&<p role="status">Connecting to secure sign-in…</p>}
        {!authenticated?<button disabled={!ready||busy} onClick={()=>login({loginMethods:['discord','email','passkey']})}>Sign in to AgentCity</button>:!order?<><button disabled={busy} onClick={()=>run('state')}>{busy?'Loading…':'Load my order'}</button><div className="order-tools"><button className="text-button" disabled={busy} onClick={()=>logout()}>Switch sign-in account</button></div></>:<>
          {order.delivered?<div className="complete-icon" aria-label="Delivered">✓</div>:<>
            {next.recovery&&recover}
            {next.action&&<button disabled={busy} onClick={()=>next.action==='link'?link():next.action==='sign'?sign():run(next.action)}>{busy?'Checking…':next.label}</button>}
            {!order.cancelled&&<p className="footnote">Keep Minecraft connected throughout checkout. Wallet confirmations open in your extension.</p>}
          </>}
          {order.walletLinked&&!order.paid&&!order.cancelled&&!order.cancelling&&!next.recovery&&<aside className="funding"><strong>{order.onboardingGrant?.status==='complete'?'Your test CITY is ready':'Need CITY for your first purchase?'}</strong>
            {order.onboardingGrant?.status==='complete'?<p>Your one-time 100 test CITY grant is confirmed.</p>:<><p>Get a one-time 100 test CITY grant for this local demo. Test tokens have no USD value.</p><button className="secondary" disabled={busy||order.onboardingGrant?.status==='reverted'} onClick={()=>run('fund')}>{order.onboardingGrant?'Check my test CITY grant':'Get 100 test CITY'}</button></>}
          </aside>}
          <div className="order-tools"><button className="text-button" disabled={busy} onClick={()=>run('state')}>Refresh order</button><button className="text-button" disabled={busy} onClick={()=>{setOrder(null);setMessage('');logout()}}>Switch sign-in account</button></div>
          <details><summary>Order help & receipts</summary>
            <p className="muted">Your original order is kept if you close this page. A wallet request or submitted transaction is not yet a confirmed payment.</p>
            <p>Wallet <code>{order.expectedWallet}</code></p>
            {order.transaction&&!next.recovery&&<details><summary>Record a transaction from my wallet</summary>{recover}</details>}
            {!!order.submitted?.length&&<ul className="receipts">{order.submitted.map((value,index)=><li key={value.operationId}><a href={'https://sepolia.uniscan.xyz/tx/'+value.hash} target="_blank" rel="noreferrer">View transaction {index+1} ↗</a></li>)}</ul>}
            {!order.paid&&!order.delivered&&!order.cancelled&&!order.cancelling&&<button className="text-button danger" disabled={busy||next.recovery} onClick={()=>run('cancel')}>Cancel unpaid order</button>}
          </details>
        </>}
      </>}
    </section><aside className="card order-summary" aria-label="Order summary"><p className="eyebrow">YOUR ORDER</p>
      <div className="material-icon" aria-hidden="true"><svg viewBox="0 0 80 80"><path d="M40 5 72 23 40 42 8 23Z" fill="#d8b875"/><path d="M8 23 40 42 40 77 8 58Z" fill="#aa8144"/><path d="M40 42 72 23 72 58 40 77Z" fill="#816035"/><path d="m19 30 32 19m-32-8 21 13m0 10 32-19" fill="none" stroke="#f5e4bb" opacity=".3" strokeWidth="2"/></svg></div>
      <h2 className="item-name">{order?label(order.item):'Your Minecraft materials'}</h2><p className="muted">{order?`${order.count} ${order.count===1?'item':'items'} · delivered to your inventory`:'Your item, quantity and price appear after sign-in.'}</p>
      <dl><dt>Quantity</dt><dd>{order?.count??'—'}</dd><dt>Materials</dt><dd>{order?order.totalCity+' CITY':'—'}</dd><dt>Wallet gas fee</dt><dd>Shown in wallet</dd></dl><div className="total"><span>Order total</span><strong>{order?order.totalCity:'—'} <small>CITY</small></strong></div>
      <p className="footnote">Unichain Sepolia · test tokens only. Gas is paid separately in test ETH.</p><div className="summary-note">Real stocked materials. Your wallet stays in your control.</div>
    </aside></div><footer>The server never receives your wallet key. Purchases are delivered after payment and release are confirmed.</footer>
  </main>
}
const root=createRoot(document.getElementById('root'))
try{
  const response=await fetch('/api/discord/config',{cache:'no-store'}),config=await response.json()
  if(!response.ok||!config.appId)throw Error('AgentCity identity configuration is unavailable.')
  root.render(<PrivyProvider appId={config.appId} config={{loginMethods:['discord','email','passkey'],embeddedWallets:{ethereum:{createOnLogin:'off'},solana:{createOnLogin:'off'}}}}><Checkout/></PrivyProvider>)
}catch(error){root.render(<main className="card"><h1>UniRock checkout</h1><p>{error.message}</p></main>)}
