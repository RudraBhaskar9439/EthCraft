export function checkoutStep(order) {
  if (!order) return {step:0,title:'Sign in',description:'Use the same Discord account you used to join Minecraft.'}
  if (order.delivered) return {step:4,title:'Your materials are ready',description:'Your purchase is complete. Return to Minecraft and check your inventory.'}
  if (order.cancelled) return {step:0,title:'Order cancelled',description:'No purchase was made. Any reserved stock has been returned.'}
  if (order.cancelling) return {step:2,title:'Returning reserved stock',description:'Finish cancelling this order before starting another.',action:'cancel',label:'Finish cancellation'}
  if (!order.walletLinked) return {step:1,title:'Connect your wallet',description:'Sign a message to prove this wallet is yours. This does not spend tokens.',action:'link',label:'Verify my wallet'}
  if (order.transaction?.unknown_outcome) return {step:order.paid?3:2,title:'Check your wallet before continuing',description:'The wallet did not return a clear result. Keep this order. Record the original transaction hash below; do not send a second payment.',recovery:true}
  if (order.transaction) return {step:order.paid?3:2,title:order.paid?'Confirm item release':'Confirm in your wallet',description:order.paid?'Approve the release of your purchased materials. Your wallet shows the testnet gas fee.':'Your wallet may ask for a CITY spending approval, then the purchase. Check each request and its gas fee.',action:'sign',label:order.paid?'Confirm item release in wallet':'Review transaction in wallet'}
  if (order.status==='ready_to_collect') return {step:3,title:'Collect your materials',description:'Keep Minecraft connected. Close its inventory menu and leave space for your items.',action:'claim',label:'Collect in Minecraft'}
  if (order.paid) return {step:3,title:'Payment confirmed',description:'Release your purchased materials, then collect them in Minecraft. Another wallet confirmation may be required.',action:'redeem',label:'Continue item delivery'}
  if (order.status==='ready_to_pay') return {step:2,title:'Ready to pay',description:'Your selected materials are reserved. Continue to review the exact CITY payment in your wallet.',action:'buy',label:'Continue to payment'}
  return {step:2,title:order.status==='preparing_stock'?'Reserving your materials':'Reserve your materials',description:'The shop prepares your exact quantity. This step does not spend your CITY. If it is still processing, use the same button to check again.',action:'prepare',label:order.status==='preparing_stock'?'Check material reservation':'Prepare my order'}
}

export function checkoutError(code, fallback) {
  if (/APPROVED_CONNECTION_REQUIRED/.test(code||'')) return 'Reconnect to Minecraft, approve the new connection with /join in Discord, then refresh this order.'
  if (/OWNER_REQUIRED/.test(code||'')) return 'This order belongs to a different account. Sign in with the same Discord account you used in Minecraft.'
  if (/LOGIN_REQUIRED/.test(code||'')) return 'Your sign-in needs refreshing. Sign in again with your AgentCity Discord account.'
  if (/REQUEST_REQUIRED/.test(code||'')) return 'Open the checkout link from your original Minecraft order.'
  if (/UNRESOLVED|RECONCILIATION_PENDING/.test(code||'')) return 'Your original transaction is still being checked. Keep this order and refresh it. Do not send another payment.'
  if (/INSUFFICIENT|BALANCE/.test(code||'')) return 'There are not enough test tokens for this step. Check your CITY balance and test ETH for gas.'
  if (/NATIVE_DELIVERY_PENDING|INVENTORY|MAILBOX/.test(code||'')) return 'Keep Minecraft connected, close its inventory menu and leave space for your items. Then retry this same step.'
  if (/MERCHANT|STOCK/.test(code||'')) return 'The shop is still checking its stock. Keep this order and retry the same step shortly.'
  return fallback||'This step is still being checked. Refresh this order and continue from the same step. Do not make a replacement payment.'
}
