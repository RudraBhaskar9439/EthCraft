// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.26;

import {BaseHook} from "@uniswap/v4-periphery/src/utils/BaseHook.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {LPFeeLibrary} from "@uniswap/v4-core/src/libraries/LPFeeLibrary.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {BeforeSwapDelta, BeforeSwapDeltaLibrary} from "@uniswap/v4-core/src/types/BeforeSwapDelta.sol";
import {StateRegistry} from "./StateRegistry.sol";
import {AgentCityBank} from "./AgentCityBank.sol";

interface IAgentCityBankRouter {
    function poolManager() external view returns (IPoolManager);
    function hook() external view returns (address);
}

/// Wallet repayment history buys a bounded loyalty discount, not unsecured
/// credit. Only the pinned router authenticates a real transaction payer.
contract AgentCityReputationHook is BaseHook {
    uint24 public constant BASE_FEE = 3000;
    uint24 public constant DISCOUNT_FEE = 2500;
    uint256 public constant QUALIFYING_REPAYMENTS = 2;
    int24 public constant TICK_SPACING = 60;
    StateRegistry public immutable registry;
    AgentCityBank public immutable bank;
    address public immutable quoter;
    address public immutable administrator;
    address public immutable city;
    address public immutable currency0;
    address public immutable currency1;
    address public router;

    event RouterBound(address indexed router);

    constructor(
        IPoolManager manager,
        StateRegistry registry_,
        AgentCityBank bank_,
        address quoter_,
        address administrator_,
        address tokenA,
        address tokenB
    ) BaseHook(manager) {
        require(block.chainid == 31337 || block.chainid == 1301, "testnet only");
        require(
            address(manager).code.length > 0 && address(registry_).code.length > 0 && address(bank_).code.length > 0
                && quoter_.code.length > 0 && administrator_ != address(0),
            "deployed hook terms"
        );
        require(tokenA.code.length > 0 && tokenB.code.length > 0 && tokenA != tokenB, "hook currencies");
        require(tokenB == address(bank_.usdc()), "bank USDC currency required");
        registry = registry_;
        bank = bank_;
        quoter = quoter_;
        administrator = administrator_;
        city = tokenA;
        (currency0, currency1) = tokenA < tokenB ? (tokenA, tokenB) : (tokenB, tokenA);
    }

    function bindRouter(address router_) external {
        require(
            msg.sender == administrator && router == address(0) && router_.code.length > 0,
            "one administrator router binding"
        );
        require(
            address(IAgentCityBankRouter(router_).poolManager()) == address(poolManager)
                && IAgentCityBankRouter(router_).hook() == address(this),
            "router hook binding"
        );
        router = router_;
        emit RouterBound(router_);
    }

    function feeFor(address payer) public view returns (uint24) {
        (,, uint256 principal, uint256 repaid, uint256 defaults,,) = bank.history(payer);
        return defaults == 0 && repaid >= QUALIFYING_REPAYMENTS
            && principal >= QUALIFYING_REPAYMENTS * bank.MIN_REPUTATION_PRINCIPAL()
            ? DISCOUNT_FEE
            : BASE_FEE;
    }

    function getHookPermissions() public pure override returns (Hooks.Permissions memory permissions) {
        permissions.beforeSwap = true;
    }

    function _beforeSwap(address sender, PoolKey calldata key, SwapParams calldata params, bytes calldata hookData)
        internal
        view
        override
        returns (bytes4, BeforeSwapDelta, uint24)
    {
        require(
            Currency.unwrap(key.currency0) == currency0 && Currency.unwrap(key.currency1) == currency1
                && address(key.hooks) == address(this) && key.fee == LPFeeLibrary.DYNAMIC_FEE_FLAG
                && key.tickSpacing == TICK_SPACING,
            "foreign reputation pool"
        );
        // Halt new CITY purchases while preserving exits that can fund debt repayment.
        if (Currency.unwrap(params.zeroForOne ? key.currency1 : key.currency0) == city) {
            require(registry.available(), "market halted");
        }
        require(router != address(0) && (sender == router || sender == quoter), "authenticated router required");
        require(hookData.length == 32, "payer hint required");
        address payer = abi.decode(hookData, (address));
        require(payer != address(0), "payer required");
        // Quoter hints affect reverted simulation only. The bound router must
        // encode its own authenticated msg.sender, never an arbitrary payer.
        return
            (
                this.beforeSwap.selector,
                BeforeSwapDeltaLibrary.ZERO_DELTA,
                feeFor(payer) | LPFeeLibrary.OVERRIDE_FEE_FLAG
            );
    }
}
