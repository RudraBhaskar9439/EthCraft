// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {SafeCallback} from "@uniswap/v4-periphery/src/base/SafeCallback.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";

/// One fixed ERC20 pool; bounded exact-input/output swaps return tokens to their sender.
/// Uses the official v4 PoolManager and SafeCallback; no inventory or Game Coin minting.
contract PlayableMarketRouter is SafeCallback, ReentrancyGuard {
    using SafeERC20 for IERC20;
    PoolKey public poolKey;
    mapping(address => mapping(bytes32 => bool)) public operationUsed;
    event SwapExecuted(bytes32 indexed operationId, address indexed trader, address indexed tokenIn,
        address tokenOut, uint256 amountIn, uint256 amountOut);

    constructor(IPoolManager manager, PoolKey memory key_) SafeCallback(manager) {
        address token0 = Currency.unwrap(key_.currency0);
        address token1 = Currency.unwrap(key_.currency1);
        require(address(manager).code.length > 0 && token0.code.length > 0 && token1.code.length > 0 && token0 < token1, "ERC20 route");
        require(key_.fee == 3000 && key_.tickSpacing == 60 && address(key_.hooks) == address(0), "fixed test pool");
        poolKey = key_;
    }

    function swapExactInput(bytes32 operationId, bool zeroForOne, uint128 amountIn, uint128 minAmountOut, uint48 deadline)
        external nonReentrant returns (uint256 amountOut)
    {
        require(block.timestamp < deadline && deadline <= block.timestamp + 120, "quote expired");
        require(operationId != bytes32(0) && !operationUsed[msg.sender][operationId], "operation used");
        require(amountIn > 0 && minAmountOut > 0 && amountIn <= uint128(type(int128).max), "swap bounds");
        operationUsed[msg.sender][operationId] = true;
        amountOut = abi.decode(poolManager.unlock(abi.encode(msg.sender, zeroForOne, true, amountIn, minAmountOut)), (uint256));
        emit SwapExecuted(operationId, msg.sender,
            Currency.unwrap(zeroForOne ? poolKey.currency0 : poolKey.currency1),
            Currency.unwrap(zeroForOne ? poolKey.currency1 : poolKey.currency0), amountIn, amountOut);
    }

    function supportsExactOutput() external pure returns (bool) {
        return true;
    }

    function swapExactOutput(bytes32 operationId, bool zeroForOne, uint128 amountOut, uint128 maxAmountIn, uint48 deadline)
        external nonReentrant returns (uint256 amountIn)
    {
        require(block.timestamp < deadline && deadline <= block.timestamp + 120, "quote expired");
        require(operationId != bytes32(0) && !operationUsed[msg.sender][operationId], "operation used");
        require(amountOut > 0 && maxAmountIn > 0 && amountOut <= uint128(type(int128).max)
            && maxAmountIn <= uint128(type(int128).max), "swap bounds");
        operationUsed[msg.sender][operationId] = true;
        amountIn = abi.decode(poolManager.unlock(abi.encode(msg.sender, zeroForOne, false, amountOut, maxAmountIn)), (uint256));
        emit SwapExecuted(operationId, msg.sender,
            Currency.unwrap(zeroForOne ? poolKey.currency0 : poolKey.currency1),
            Currency.unwrap(zeroForOne ? poolKey.currency1 : poolKey.currency0), amountIn, amountOut);
    }

    function _unlockCallback(bytes calldata data) internal override returns (bytes memory) {
        (address payer, bool zeroForOne, bool exactInput, uint128 amount, uint128 limit) =
            abi.decode(data, (address, bool, bool, uint128, uint128));
        BalanceDelta delta = poolManager.swap(poolKey, SwapParams({
            zeroForOne: zeroForOne,
            amountSpecified: exactInput ? -int256(uint256(amount)) : int256(uint256(amount)),
            sqrtPriceLimitX96: zeroForOne ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1
        }), "");
        int128 inputDelta = zeroForOne ? delta.amount0() : delta.amount1();
        int128 outputDelta = zeroForOne ? delta.amount1() : delta.amount0();
        require(inputDelta < 0 && outputDelta > 0, exactInput ? "incomplete exact input" : "incomplete exact output");
        uint256 amountIn = uint256(-int256(inputDelta));
        uint256 amountOut = uint128(outputDelta);
        if (exactInput) {
            require(amountIn == amount, "incomplete exact input");
            require(amountOut >= limit, "minimum output");
        } else {
            require(amountOut == amount, "incomplete exact output");
            require(amountIn <= limit, "maximum input");
        }
        Currency input = zeroForOne ? poolKey.currency0 : poolKey.currency1;
        Currency output = zeroForOne ? poolKey.currency1 : poolKey.currency0;
        poolManager.sync(input);
        IERC20(Currency.unwrap(input)).safeTransferFrom(payer, address(poolManager), amountIn);
        require(poolManager.settle() == amountIn, "settlement amount");
        poolManager.take(output, payer, amountOut);
        return abi.encode(exactInput ? amountOut : amountIn);
    }
}
