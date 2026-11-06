// Keep both game transports on the same swap grammar and amount semantics.
export function parseSwapCommand(args) {
  if (args[0] !== 'receive') return {amount:args[0],tokenIn:args[1],tokenOut:args[2]}
  if (args.length < 4 || args.length > 5) throw Error('Use /swap receive <output amount> <input token> <output token> [maximum input]')
  return {kind:'exact_output',amount:args[1],tokenIn:args[2],tokenOut:args[3],
    ...(args[4] === undefined ? {} : {maxAmountIn:args[4]})}
}

export function swapAmountRequest(input) {
  if (input.kind === 'exact_output') return {amountOut:input.amount,
    ...(input.maxAmountIn === undefined ? {} : {maxAmountIn:input.maxAmountIn})}
  if (input.kind !== undefined && input.kind !== 'exact_input' || input.maxAmountIn !== undefined) throw Error('MARKET_SWAP_MODE_REQUIRED')
  return {amountIn:input.amount}
}
