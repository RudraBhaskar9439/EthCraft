import React, { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { PrivyProvider, usePrivy, useLinkAccount } from '@privy-io/react-auth'

const freshChallenge = new URLSearchParams(location.hash.slice(1)).get('challenge')
let savedChallenge
try { savedChallenge = JSON.parse(sessionStorage.getItem('agentcity-discord-setup') || 'null') } catch {}
const challenge = freshChallenge || (savedChallenge?.expiresAt > Date.now() ? savedChallenge.value : null)
if (freshChallenge) sessionStorage.setItem('agentcity-discord-setup', JSON.stringify({ value: freshChallenge, expiresAt: Date.now() + 600000 }))
history.replaceState(null, '', location.pathname + location.search)
function setupFailureMessage(code) {
  if (['DISCORD_SETUP_EXPIRED_OR_USED', 'DISCORD_SETUP_INVALID'].includes(code)) return 'This setup link expired or was already used. Return to Discord and run /start for a fresh link.'
  if (['PRIVY_VERIFIED_DISCORD_ACCOUNT_MISMATCH', 'DISCORD_LINKED_ACCOUNT_MISMATCH'].includes(code)) return 'The signed-in Discord account does not match the account that requested this link. Sign in with that Discord account, then try again.'
  if (['PRIVY_TOKEN_INVALID', 'PRIVY_TOKEN_EXPIRED', 'PRIVY_USER_BINDING_INVALID', 'WALLET_TOKEN_INVALID'].includes(code)) return 'Your sign-in could not be verified. Sign out, sign back in, then try Finish Discord setup again. If it continues, ask the operator to check Privy verification.'
  if (code === 'PRIVY_USER_LOOKUP_UNAVAILABLE') return 'Your sign-in succeeded, but the account service is temporarily unavailable. Try finishing setup again shortly.'
  if (['LEGACY_OWNER_REQUIRES_REVIEW', 'LEGACY_OWNER_BINDING_CONFLICT', 'LEGACY_WALLET_OWNER_BINDING_CONFLICT', 'LEGACY_WALLET_ALIAS_BINDING_CONFLICT', 'LEGACY_MINECRAFT_ALIAS_BINDING_CONFLICT', 'DISCORD_OWNER_BINDING_CONFLICT', 'DISCORD_PRIVY_OWNER_CONFLICT', 'EXISTING_MINECRAFT_OWNER_LOGIN_REQUIRED'].includes(code)) return 'Sign in to the original account associated with your existing AgentCity profile, then link Discord. If it still fails, ask the operator to review the owner binding.'
  if (['DISCORD_SETUP_ORIGIN_REQUIRED', 'PUBLIC_SETUP_ORIGIN_REQUIRED'].includes(code)) return 'This setup page uses an outdated server address. Return to Discord and open a fresh /start link.'
  return 'The setup service could not finish. Try again shortly; if it continues, ask the operator to check onboarding.'
}
function Setup({ walletSetupAvailable = true }) {
  const { ready, authenticated, user, login, getAccessToken, logout } = usePrivy()
  const { linkDiscord } = useLinkAccount({ onError: () => setMessage('Discord linking did not finish. Try again from this signed-in account.') })
  const [message, setMessage] = useState('Existing wallet? Sign in to that existing account first, then link Discord. New player? Continue with Discord.')
  const [busy, setBusy] = useState(false), [verified, setVerified] = useState(false), [wallet, setWallet] = useState(null)
  const linked = user?.linkedAccounts?.some(account => account.type === 'discord_oauth') || Boolean(user?.discord)
  async function send(path, fields) {
    let accessToken
    try { accessToken = await getAccessToken() } catch { throw Error(setupFailureMessage('PRIVY_TOKEN_INVALID')) }
    if (!accessToken) throw Error('Sign in again to continue.')
    let response, result
    try {
      response = await fetch(path, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...fields, accessToken }) })
      result = await response.json()
    } catch { throw Error(setupFailureMessage('DISCORD_SETUP_UNAVAILABLE')) }
    if (!response.ok) throw Error(setupFailureMessage(result?.error))
    return result
  }
  async function finish() {
    setBusy(true)
    try {
      if (!challenge) throw Error('Open your private setup link from Discord /start.')
      const result = await send('/api/discord/complete', { challenge })
      if (!result.verified) throw Error('Account verification did not finish.')
      sessionStorage.removeItem('agentcity-discord-setup')
      setVerified(true); setMessage(walletSetupAvailable
        ? 'Account connected. Return to Discord and use /profile to choose your game name and login route, then /agents to create or open your agent.'
        : 'Account connected. Return to Discord and use /profile to choose your game name and login route, then /join to approve your Minecraft connection. Wallet setup is unavailable in this session.')
    } catch (error) { setMessage(error.message) } finally { setBusy(false) }
  }
  async function openWallet() {
    setBusy(true)
    try { const result = await send('/api/discord/wallet', {}); setWallet(result.wallet); setMessage(result.message) }
    catch (error) { setMessage(error.message) } finally { setBusy(false) }
  }
  return <main className="card"><p className="eyebrow">AGENTCITY · DISCORD SETUP</p><h1>Your game. Your agent.</h1><p>Connect once here. Keep Minecraft for playing.</p><p role="status">{message}</p>
    {!ready && <p>Connecting to secure login…</p>}
    {authenticated ? <><p>Signed in. {linked ? 'Discord is linked.' : 'Link Discord to this existing account.'}</p>
      {!linked && <button disabled={!ready || busy} onClick={() => linkDiscord()}>Link my Discord account</button>}
      <button disabled={!ready || busy || !linked || !challenge || verified} onClick={finish}>{verified ? 'Account connected' : 'Finish Discord setup'}</button>
      {verified && (walletSetupAvailable
        ? <button disabled={busy} onClick={openWallet}>Create or view my managed test wallet</button>
        : <p>Wallet setup is unavailable in this session. Return to Discord to approve your Minecraft connection.</p>)}
      {wallet && <p>Unichain Sepolia · <code>{wallet.address}</code><br/>Testnet wallet; transactions need separate authorization.</p>}
      <button className="secondary" disabled={busy} onClick={() => logout()}>Sign out</button></> : <>
      <button disabled={!ready || busy} onClick={() => login({ loginMethods: ['discord'] })}>New player · continue with Discord</button>
      <button className="secondary" disabled={!ready || busy} onClick={() => login({ loginMethods: ['email', 'passkey'] })}>Existing wallet · sign in first</button></>}
  </main>
}
const root = createRoot(document.getElementById('root'))
try {
  const response = await fetch('/api/discord/config', { cache: 'no-store' }), config = await response.json()
  if (!response.ok || !config.configured || !config.appId) throw Error('Discord onboarding is awaiting the server configuration.')
  root.render(<PrivyProvider appId={config.appId} config={{ loginMethods: ['discord', 'email', 'passkey'], embeddedWallets: { ethereum: { createOnLogin: 'off' }, solana: { createOnLogin: 'off' } } }}><Setup walletSetupAvailable={config.walletSetupAvailable !== false} /></PrivyProvider>)
} catch (error) { root.render(<main className="card"><h1>AgentCity setup</h1><p>{error.message}</p><p>Return to Discord and request a new setup link once the server is ready.</p></main>) }
