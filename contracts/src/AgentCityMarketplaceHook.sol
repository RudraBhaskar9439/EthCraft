// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.26;

import {BaseHook} from "@uniswap/v4-periphery/src/utils/BaseHook.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {FullMath} from "@uniswap/v4-core/src/libraries/FullMath.sol";
import {LPFeeLibrary} from "@uniswap/v4-core/src/libraries/LPFeeLibrary.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {SwapParams, ModifyLiquidityParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {BalanceDelta, BalanceDeltaLibrary} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {BeforeSwapDelta, BeforeSwapDeltaLibrary} from "@uniswap/v4-core/src/types/BeforeSwapDelta.sol";
import {StateRegistry} from "./StateRegistry.sol";

interface IAgentCityMarketplaceRouter {
    function poolManager() external view returns (IPoolManager);
    function hook() external view returns (address);
}

/// Testnet market guard. Pool history reduces short-lived manipulation risk;
/// it is not an independent fair-value oracle or a guarantee against LP losses.
contract AgentCityMarketplaceHook is BaseHook {
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;
    using BalanceDeltaLibrary for BalanceDelta;

    uint64 public constant WINDOW = 300;
    uint64 public constant MAX_REFERENCE_AGE = 600;
    uint64 public constant SAMPLE_INTERVAL = 30;
    uint8 public constant OBSERVATION_CAPACITY = 64;
    int24 public constant TICK_SPACING = 60;
    uint24 public constant MAX_DEVIATION_TICKS = 200;
    uint24 public constant MAX_IMPACT_TICKS = 50;
    uint256 public constant MAX_EXECUTION_DEVIATION_BPS = 200;
    uint128 public constant MAX_CITY_OUTPUT = 10e18;
    uint128 public constant MAX_USDC_OUTPUT = 10e6;
    uint128 public constant BLOCK_CITY_OUTPUT = 20e18;
    uint128 public constant BLOCK_USDC_OUTPUT = 20e6;
    uint24 public constant BASE_FEE = 3000;
    uint24 public constant MAX_FEE = 10000;

    struct Observation {
        uint64 timestamp;
        int192 cumulative;
    }
    Observation[64] public observations;
    uint8 public observationCount;
    uint8 public nextObservation;
    uint64 public lastTimestamp;
    uint64 public liquidSince;
    int192 public tickCumulative;
    int24 public priorTick;
    uint128 public activeLiquidity;
    uint256 public volumeBlock;
    uint128 public cityOutputThisBlock;
    uint128 public usdcOutputThisBlock;
    bool public initialized;
    bool public paused;

    StateRegistry public immutable registry;
    address public immutable administrator;
    address public immutable city;
    address public immutable usdc;
    address public immutable currency0;
    address public immutable currency1;
    address public immutable quoter;
    uint128 public immutable minActiveLiquidity;
    PoolId public immutable poolId;
    address public router;
    bool private swapping;
    int24 private tradeTick;
    int24 private tradeReference;

    event RouterBound(address indexed router);
    event PauseChanged(bool paused);
    event ObservationWritten(uint64 timestamp, int192 cumulative);

    constructor(
        IPoolManager manager,
        StateRegistry registry_,
        address admin_,
        address city_,
        address usdc_,
        address quoter_,
        uint128 minimumLiquidity
    ) BaseHook(manager) {
        require(block.chainid == 31337 || block.chainid == 1301, "testnet only");
        require(
            address(manager).code.length != 0 && address(registry_).code.length != 0 && quoter_.code.length != 0,
            "deployed dependencies required"
        );
        require(
            admin_ != address(0) && city_ != usdc_ && city_.code.length != 0 && usdc_.code.length != 0
                && minimumLiquidity != 0,
            "market configuration required"
        );
        require(
            IERC20Metadata(city_).decimals() == 18 && IERC20Metadata(usdc_).decimals() == 6,
            "18/6 token decimals required"
        );
        registry = registry_;
        administrator = admin_;
        city = city_;
        usdc = usdc_;
        quoter = quoter_;
        minActiveLiquidity = minimumLiquidity;
        (currency0, currency1) = city_ < usdc_ ? (city_, usdc_) : (usdc_, city_);
        poolId = PoolKey(
                Currency.wrap(currency0),
                Currency.wrap(currency1),
                LPFeeLibrary.DYNAMIC_FEE_FLAG,
                TICK_SPACING,
                IHooks(address(this))
            ).toId();
    }

    function bindRouter(address value) external {
        require(msg.sender == administrator && router == address(0) && value.code.length != 0, "router bind denied");
        require(
            address(IAgentCityMarketplaceRouter(value).poolManager()) == address(poolManager)
                && IAgentCityMarketplaceRouter(value).hook() == address(this),
            "foreign router"
        );
        router = value;
        emit RouterBound(value);
    }

    function setPaused(bool value) external {
        require(msg.sender == administrator, "administrator required");
        paused = value;
        emit PauseChanged(value);
    }

    function getHookPermissions() public pure override returns (Hooks.Permissions memory p) {
        p.afterInitialize = true;
        p.beforeAddLiquidity = true;
        p.afterAddLiquidity = true;
        p.beforeRemoveLiquidity = true;
        p.afterRemoveLiquidity = true;
        p.beforeSwap = true;
        p.afterSwap = true;
    }

    function _check(PoolKey calldata key) private view {
        require(PoolId.unwrap(key.toId()) == PoolId.unwrap(poolId), "foreign marketplace pool");
    }

    function _accrue() private {
        require(block.timestamp <= type(uint64).max && block.timestamp >= lastTimestamp, "invalid oracle time");
        tickCumulative += int192(priorTick) * int192(uint192(block.timestamp - lastTimestamp));
        lastTimestamp = uint64(block.timestamp);
        _record();
    }

    function _record() private {
        uint8 previous = uint8((uint256(nextObservation) + 63) % 64);
        if (observationCount != 0 && lastTimestamp - observations[previous].timestamp < SAMPLE_INTERVAL) return;
        observations[nextObservation] = Observation(lastTimestamp, tickCumulative);
        nextObservation = uint8((uint256(nextObservation) + 1) % 64);
        if (observationCount < OBSERVATION_CAPACITY) observationCount++;
        emit ObservationWritten(lastTimestamp, tickCumulative);
    }

    function _sync() private {
        (, priorTick,,) = poolManager.getSlot0(poolId);
        activeLiquidity = poolManager.getLiquidity(poolId);
        if (activeLiquidity < minActiveLiquidity) liquidSince = 0;
        else if (liquidSince == 0) liquidSince = uint64(block.timestamp);
    }

    /// No supplied price: all observations come from this exact PoolManager pool.
    function checkpoint() external {
        require(initialized, "pool not initialized");
        _accrue();
        _sync();
    }

    function marketReference() public view returns (bool ready, int24 meanTick, uint64 anchorTimestamp, uint64 age) {
        if (
            !initialized || liquidSince == 0 || activeLiquidity < minActiveLiquidity
                || block.timestamp < uint256(liquidSince) + WINDOW
        ) return (false, 0, 0, 0);
        int256 cumulative = int256(tickCumulative) + int256(priorTick) * int256(block.timestamp - lastTimestamp);
        for (uint256 offset; offset < observationCount; offset++) {
            Observation memory old = observations[(uint256(nextObservation) + 63 - offset) % 64];
            uint256 elapsed = block.timestamp - old.timestamp;
            if (elapsed < WINDOW) continue;
            if (elapsed > MAX_REFERENCE_AGE || old.timestamp < liquidSince) {
                return (false, 0, old.timestamp, uint64(elapsed));
            }
            int256 delta = cumulative - old.cumulative;
            int256 duration = int256(elapsed);
            int256 average = delta / duration;
            if (delta < 0 && delta % duration != 0) average--;
            return (true, int24(average), old.timestamp, uint64(elapsed));
        }
    }

    function _distance(int24 a, int24 b) private pure returns (uint24) {
        int256 delta = int256(a) - int256(b);
        return uint24(uint256(delta < 0 ? -delta : delta));
    }

    /// The ignored address preserves caller compatibility; there are no credit tiers.
    function feeFor(address) external view returns (uint24) {
        (bool ready, int24 mean,,) = marketReference();
        return ready ? _fee(priorTick, mean) : BASE_FEE;
    }

    function _fee(int24 tick, int24 mean) private pure returns (uint24) {
        uint256 surcharge = uint256(_distance(tick, mean)) * 100;
        return BASE_FEE + uint24(surcharge > MAX_FEE - BASE_FEE ? MAX_FEE - BASE_FEE : surcharge);
    }

    function _afterInitialize(address, PoolKey calldata key, uint160, int24 tick) internal override returns (bytes4) {
        _check(key);
        require(!initialized, "already initialized");
        initialized = true;
        lastTimestamp = uint64(block.timestamp);
        priorTick = tick;
        _record();
        return this.afterInitialize.selector;
    }

    function _beforeAddLiquidity(address, PoolKey calldata key, ModifyLiquidityParams calldata, bytes calldata)
        internal
        override
        returns (bytes4)
    {
        _check(key);
        _accrue();
        return this.beforeAddLiquidity.selector;
    }

    function _beforeRemoveLiquidity(address, PoolKey calldata key, ModifyLiquidityParams calldata, bytes calldata)
        internal
        override
        returns (bytes4)
    {
        _check(key);
        _accrue();
        return this.beforeRemoveLiquidity.selector;
    }

    function _afterAddLiquidity(
        address,
        PoolKey calldata key,
        ModifyLiquidityParams calldata,
        BalanceDelta,
        BalanceDelta,
        bytes calldata
    ) internal override returns (bytes4, BalanceDelta) {
        _check(key);
        _sync();
        return (this.afterAddLiquidity.selector, BalanceDeltaLibrary.ZERO_DELTA);
    }

    function _afterRemoveLiquidity(
        address,
        PoolKey calldata key,
        ModifyLiquidityParams calldata,
        BalanceDelta,
        BalanceDelta,
        bytes calldata
    ) internal override returns (bytes4, BalanceDelta) {
        _check(key);
        _sync();
        return (this.afterRemoveLiquidity.selector, BalanceDeltaLibrary.ZERO_DELTA);
    }

    function _beforeSwap(address sender, PoolKey calldata key, SwapParams calldata params, bytes calldata hookData)
        internal
        override
        returns (bytes4, BeforeSwapDelta, uint24)
    {
        _check(key);
        require(!paused && !swapping, "marketplace paused");
        require(router != address(0) && (sender == router || sender == quoter), "authenticated router required");
        require(hookData.length == 32 && abi.decode(hookData, (address)) != address(0), "payer required");
        require(params.amountSpecified > 0, "exact output required");
        bool buysCity = Currency.unwrap(params.zeroForOne ? key.currency1 : key.currency0) == city;
        if (buysCity) require(registry.available(), "market halted");
        uint256 output = uint256(params.amountSpecified);
        require(output <= (buysCity ? MAX_CITY_OUTPUT : MAX_USDC_OUTPUT), "trade output cap");
        _accrue();
        (bool ready, int24 mean,,) = marketReference();
        require(ready, "reference not ready");
        require(_distance(priorTick, mean) <= MAX_DEVIATION_TICKS, "spot outside reference");
        if (volumeBlock != block.number) {
            volumeBlock = block.number;
            cityOutputThisBlock = 0;
            usdcOutputThisBlock = 0;
        }
        if (buysCity) {
            require(uint256(cityOutputThisBlock) + output <= BLOCK_CITY_OUTPUT, "block CITY cap");
            cityOutputThisBlock += uint128(output);
        } else {
            require(uint256(usdcOutputThisBlock) + output <= BLOCK_USDC_OUTPUT, "block USDC cap");
            usdcOutputThisBlock += uint128(output);
        }
        swapping = true;
        tradeTick = priorTick;
        tradeReference = mean;
        return (
            this.beforeSwap.selector,
            BeforeSwapDeltaLibrary.ZERO_DELTA,
            _fee(priorTick, mean) | LPFeeLibrary.OVERRIDE_FEE_FLAG
        );
    }

    // Raw PoolManager prices already include token ordering and the 6/18 decimals.
    function _referenceInput(int24 tick, uint128 output, bool zeroForOne) private pure returns (uint256) {
        uint160 sqrt = TickMath.getSqrtPriceAtTick(tick);
        if (sqrt <= type(uint128).max) {
            uint256 ratio = uint256(sqrt) * sqrt;
            return zeroForOne
                ? FullMath.mulDiv(output, uint256(1) << 192, ratio)
                : FullMath.mulDiv(output, ratio, uint256(1) << 192);
        }
        uint256 ratio128 = FullMath.mulDiv(sqrt, sqrt, uint256(1) << 64);
        return zeroForOne
            ? FullMath.mulDiv(output, uint256(1) << 128, ratio128)
            : FullMath.mulDiv(output, ratio128, uint256(1) << 128);
    }

    function _afterSwap(address, PoolKey calldata key, SwapParams calldata params, BalanceDelta delta, bytes calldata)
        internal
        override
        returns (bytes4, int128)
    {
        _check(key);
        require(swapping, "swap context required");
        _sync();
        require(activeLiquidity >= minActiveLiquidity, "insufficient active liquidity");
        require(_distance(priorTick, tradeReference) <= MAX_DEVIATION_TICKS, "result outside reference");
        require(_distance(priorTick, tradeTick) <= MAX_IMPACT_TICKS, "trade price impact");
        int128 input = params.zeroForOne ? delta.amount0() : delta.amount1();
        int128 output = params.zeroForOne ? delta.amount1() : delta.amount0();
        require(
            input < 0 && output > 0 && uint256(uint128(output)) == uint256(params.amountSpecified),
            "incomplete exact output"
        );
        uint256 expected = _referenceInput(tradeReference, uint128(output), params.zeroForOne);
        require(
            expected != 0 && uint256(-int256(input)) * 10000 <= expected * (10000 + MAX_EXECUTION_DEVIATION_BPS),
            "execution outside reference"
        );
        swapping = false;
        return (this.afterSwap.selector, 0);
    }
}
