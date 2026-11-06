// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.26;

import {BaseHook} from "@uniswap/v4-periphery/src/utils/BaseHook.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {BeforeSwapDelta, BeforeSwapDeltaLibrary} from "@uniswap/v4-core/src/types/BeforeSwapDelta.sol";
import {StateRegistry} from "./StateRegistry.sol";

/// A symmetric halt for the one declared pool; liquidity removal has no hook callback.
contract AgentCityHook is BaseHook {
    StateRegistry public immutable registry;
    address public immutable currency0;
    address public immutable currency1;
    uint24 public constant FEE = 3000;
    int24 public constant TICK_SPACING = 60;

    constructor(IPoolManager manager, StateRegistry registry_, address tokenA, address tokenB) BaseHook(manager) {
        require(tokenA != address(0) && tokenB != address(0) && tokenA != tokenB, "currencies");
        registry = registry_;
        (currency0, currency1) = tokenA < tokenB ? (tokenA, tokenB) : (tokenB, tokenA);
    }

    function getHookPermissions() public pure override returns (Hooks.Permissions memory permissions) {
        permissions.beforeSwap = true;
    }

    function _beforeSwap(address, PoolKey calldata key, SwapParams calldata, bytes calldata)
        internal view override returns (bytes4, BeforeSwapDelta, uint24)
    {
        require(Currency.unwrap(key.currency0) == currency0 && Currency.unwrap(key.currency1) == currency1, "foreign currencies");
        require(address(key.hooks) == address(this) && key.fee == FEE && key.tickSpacing == TICK_SPACING, "foreign pool");
        require(registry.available(), "market halted");
        return (this.beforeSwap.selector, BeforeSwapDeltaLibrary.ZERO_DELTA, 0);
    }
}
