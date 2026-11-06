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
import {KitCustody} from "./KitCustody.sol";

/// Local fixed-route exact-output adapter using the real v4 manager and official SafeCallback.
contract Procurement is SafeCallback, ReentrancyGuard {
    using SafeERC20 for IERC20;
    IERC20 public immutable cred;
    KitCustody public immutable kit;
    PoolKey public key;
    event Purchased(bytes32 indexed jobId, bytes32 indexed claimId, address indexed requester, uint256 kits, uint256 spentCred);

    constructor(IPoolManager manager, IERC20 cred_, KitCustody kit_, PoolKey memory key_) SafeCallback(manager) {
        require(Currency.unwrap(key_.currency0) == address(cred_) && Currency.unwrap(key_.currency1) == address(kit_) ||
            Currency.unwrap(key_.currency1) == address(cred_) && Currency.unwrap(key_.currency0) == address(kit_), "route");
        require(address(key_.hooks) != address(0), "hook required");
        cred = cred_;
        kit = kit_;
        key = key_;
    }

    function buyAndRedeem(bytes32 jobId, uint256 kits, uint256 maxCred, uint64 deadline, bytes32 destinationHash)
        external nonReentrant returns (bytes32 claimId, uint256 spentCred)
    {
        require(block.timestamp < deadline && deadline <= block.timestamp + 60, "quote expired");
        require(kits > 0 && kits <= uint256(type(int256).max) / 1e18 && maxCred > 0, "purchase bounds");
        spentCred = abi.decode(poolManager.unlock(abi.encode(msg.sender, kits, maxCred)), (uint256));
        claimId = kit.redeem(kits, jobId, msg.sender, destinationHash);
        emit Purchased(jobId, claimId, msg.sender, kits, spentCred);
    }

    function _unlockCallback(bytes calldata data) internal override returns (bytes memory) {
        (address payer, uint256 kits, uint256 maxCred) = abi.decode(data, (address, uint256, uint256));
        bool zeroForOne = Currency.unwrap(key.currency0) == address(cred);
        uint256 output = kits * 1e18;
        BalanceDelta delta = poolManager.swap(key, SwapParams({
            zeroForOne: zeroForOne,
            amountSpecified: int256(output),
            sqrtPriceLimitX96: zeroForOne ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1
        }), "");
        int128 inputDelta = zeroForOne ? delta.amount0() : delta.amount1();
        int128 outputDelta = zeroForOne ? delta.amount1() : delta.amount0();
        require(inputDelta < 0 && outputDelta >= 0 && uint128(outputDelta) == output, "incomplete output");
        uint256 spent = uint256(-int256(inputDelta));
        require(spent <= maxCred, "purchase cap");
        Currency inputCurrency = zeroForOne ? key.currency0 : key.currency1;
        Currency outputCurrency = zeroForOne ? key.currency1 : key.currency0;
        poolManager.sync(inputCurrency);
        cred.safeTransferFrom(payer, address(poolManager), spent);
        poolManager.settle();
        poolManager.take(outputCurrency, address(this), output);
        return abi.encode(spent);
    }
}
