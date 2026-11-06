import React, { useState, useEffect } from 'react'
import { createRoot } from 'react-dom/client'
import { PrivyProvider, usePrivy, useLoginWithPasskey } from '@privy-io/react-auth'

// Keep the short-lived game capability only in memory. The provider SDK owns
// its authentication lifecycle; this app never writes JWTs/keys to storage.
const challenge = new URLSearchParams(location.hash.slice(1)).get('challenge')
history.replaceState(null, '', location.pathname + location.search)
function Login() {
  const { ready, authenticated, user, login, getAccessToken, logout } = usePrivy()
  const [message, setMessage] = useState(challenge ? 'Log in, then link this Minecraft connection. Rejoining requires a new game login link.' : 'Sign in to see your public Privy user ID. After enrollment, use /wallet in Minecraft to link your game connection.')
  const [slow, setSlow] = useState(false)
  useEffect(() => { const timer=setTimeout(()=>setSlow(true),15000); return()=>clearTimeout(timer) }, [])
  const [busy, setBusy] = useState(false)
  const [linked, setLinked] = useState(false)
  const { loginWithPasskey } = useLoginWithPasskey({ onError: () => setMessage('Passkey login did not complete. Use email if you have no registered passkey.') })
  async function link() {
    setBusy(true)
    try {
      if (!challenge || !/^[A-Za-z0-9_-]{43}$/.test(challenge)) throw Error('Open the fresh login link from Minecraft first.')
      const accessToken = await getAccessToken()
      if (!accessToken) throw Error('Your login expired. Log in again.')
      const response = await fetch('/api/player-wallet/link', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ challenge, accessToken }) })
      const result = await response.json()
      if (!response.ok || !result.verified) {
        const code = result.error || result.code
        throw Error(code === 'WALLET_ENROLLMENT_NOT_APPROVED' ? 'Ask the server operator to approve the Privy user ID shown below for your Minecraft UUID, then try Link again.' : code === 'WALLET_LOGIN_EXPIRED_OR_USED' || code === 'WALLET_GAME_SESSION_CHANGED' ? 'This link expired or your Minecraft connection changed. Request a fresh login link in the game.' : 'Linking was refused. Check your approved identity and request a fresh game login link.')
      }
      setLinked(true); setMessage('This Minecraft connection is verified. Return to the game. Wallet actions still require their own explicit confirmation.')
    } catch (error) { setMessage(error.message || 'Login could not be completed.') }
    finally { setBusy(false) }
  }
  return <section>
    <h1>Player wallet login</h1>
    <p>Verify your account for this Minecraft connection using email or a registered passkey.</p>
    <p role="status">{message}</p>
    {!ready && <p role="status">{slow ? 'Privy is taking longer to initialize. Check your connection and that this site is allowed in the server’s Privy app.' : 'Connecting to Privy…'}</p>}
    {!challenge && <p>You can sign in here now. Linking the game requires a fresh /wallet link from Minecraft.</p>}
    {authenticated ? <>
      <p>Your Privy user ID: <code>{user?.id}</code></p>
      <p>The operator must approve this identity for your Minecraft UUID before the first link.</p>
      <button disabled={!ready || busy || linked || !challenge} onClick={link}>{busy ? 'Verifying…' : linked ? 'Connection verified' : 'Link this game connection'}</button>
      <button disabled={busy} onClick={() => logout()}>Log out</button>
    </> : <>
      <button disabled={!ready || busy} onClick={() => login({ loginMethods: ['email'] })}>Log in with email</button>
      <button disabled={!ready || busy} onClick={() => loginWithPasskey()}>Use a registered passkey</button>
    </>}
  </section>
}
const root = createRoot(document.getElementById('root'))
try {
  const response = await fetch('/api/player-wallet/config', { cache: 'no-store', credentials: 'same-origin' })
  const configuration = await response.json()
  if (!response.ok || typeof configuration.appId !== 'string' || !configuration.appId) throw Error('Player wallet login is awaiting server Privy configuration. Ask the operator to configure the provider before trying again.')
  root.render(<PrivyProvider appId={configuration.appId} config={{ loginMethods: ['email'], embeddedWallets: { ethereum: { createOnLogin: 'off' }, solana: { createOnLogin: 'off' } } }}><Login /></PrivyProvider>)
} catch (error) { root.render(<main><h1>Player wallet login</h1><p role="status">{error.message}</p></main>) }
