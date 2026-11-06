// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {PoolManager} from "@uniswap/v4-core/src/PoolManager.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {SwapParams, ModifyLiquidityParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {BalanceDelta, BalanceDeltaLibrary} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {CustomRevert} from "@uniswap/v4-core/src/libraries/CustomRevert.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {PoolModifyLiquidityTest} from "@uniswap/v4-core/src/test/PoolModifyLiquidityTest.sol";
import {SafeCallback} from "@uniswap/v4-periphery/src/base/SafeCallback.sol";
import {V4Quoter} from "@uniswap/v4-periphery/src/lens/V4Quoter.sol";
import {IV4Quoter} from "@uniswap/v4-periphery/src/interfaces/IV4Quoter.sol";
import {AgentCityMarketplaceHook} from "agentcity/AgentCityMarketplaceHook.sol";
import {StateRegistry} from "agentcity/StateRegistry.sol";

contract MarketplaceTokenFixture is ERC20 {
    uint8 private immutable units;

    constructor(uint8 decimals_) ERC20("Marketplace fixture", "FIX") {
        units = decimals_;
    }

    function decimals() public view override returns (uint8) {
        return units;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

/// Isolated exact-output payer fixture. Quotes use the actual official V4Quoter.
contract MarketplaceRouterFixture is SafeCallback {
    using BalanceDeltaLibrary for BalanceDelta;
    address public immutable hook;
    PoolKey private key;

    constructor(IPoolManager manager, address hook_, PoolKey memory key_) SafeCallback(manager) {
        hook = hook_;
        key = key_;
    }

    function swap(bool zeroForOne, uint128 output, uint256 maximum) external returns (uint256) {
        return abi.decode(poolManager.unlock(abi.encode(msg.sender, zeroForOne, output, maximum)), (uint256));
    }

    function _unlockCallback(bytes calldata data) internal override returns (bytes memory) {
        (address payer, bool zeroForOne, uint128 output, uint256 maximum) =
            abi.decode(data, (address, bool, uint128, uint256));
        BalanceDelta delta = poolManager.swap(
            key,
            SwapParams(
                zeroForOne,
                int256(uint256(output)),
                zeroForOne ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1
            ),
            abi.encode(payer)
        );
        int128 input = zeroForOne ? delta.amount0() : delta.amount1();
        int128 received = zeroForOne ? delta.amount1() : delta.amount0();
        require(input < 0 && received > 0 && uint128(received) == output, "fixture incomplete output");
        uint256 spent = uint256(-int256(input));
        require(spent <= maximum, "fixture maximum input");
        Currency tokenIn = zeroForOne ? key.currency0 : key.currency1;
        Currency tokenOut = zeroForOne ? key.currency1 : key.currency0;
        poolManager.sync(tokenIn);
        IERC20(Currency.unwrap(tokenIn)).transferFrom(payer, address(poolManager), spent);
        require(poolManager.settle() == spent, "fixture settlement");
        poolManager.take(tokenOut, payer, output);
        return abi.encode(spent);
    }
}

contract AgentCityMarketplaceHookTest is Test {
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;
    MarketplaceTokenFixture city;
    MarketplaceTokenFixture usdc;
    PoolManager manager;
    PoolModifyLiquidityTest liquidity;
    AgentCityMarketplaceHook hook;
    StateRegistry health;
    MarketplaceRouterFixture router;
    V4Quoter quoter;
    PoolKey key;
    int24 lower;
    int24 upper;
    address trader = address(0xB0B);
    uint128 constant SEED = 1e16;
    uint128 constant FLOOR = 1e15;

    function setUp() public {
        vm.chainId(31337);
        vm.warp(1000);
        vm.roll(1);
        deployCodeTo("AgentCityMarketplaceHook.t.sol:MarketplaceTokenFixture", abi.encode(uint8(18)), address(0x10000));
        deployCodeTo("AgentCityMarketplaceHook.t.sol:MarketplaceTokenFixture", abi.encode(uint8(6)), address(0x20000));
        city = MarketplaceTokenFixture(address(0x10000));
        usdc = MarketplaceTokenFixture(address(0x20000));
        manager = new PoolManager(address(this));
        liquidity = new PoolModifyLiquidityTest(manager);
        quoter = new V4Quoter(manager);
        health = new StateRegistry(address(this), keccak256("marketplace fixture"));
        address hookAddress = address(0xB01FC0);
        deployCodeTo(
            "AgentCityMarketplaceHook.sol:AgentCityMarketplaceHook",
            abi.encode(manager, health, address(this), city, usdc, quoter, FLOOR),
            hookAddress
        );
        hook = AgentCityMarketplaceHook(hookAddress);
        key = PoolKey(Currency.wrap(address(city)), Currency.wrap(address(usdc)), 0x800000, 60, IHooks(hookAddress));
        router = new MarketplaceRouterFixture(manager, hookAddress, key);
        hook.bindRouter(address(router));
        city.mint(address(this), 100000e18);
        usdc.mint(address(this), 100000e6);
        city.mint(trader, 1000e18);
        usdc.mint(trader, 1000e6);
        city.approve(address(liquidity), type(uint256).max);
        usdc.approve(address(liquidity), type(uint256).max);
        vm.startPrank(trader);
        city.approve(address(router), type(uint256).max);
        usdc.approve(address(router), type(uint256).max);
        vm.stopPrank();
        uint160 price = uint160((uint256(1) << 96) / 1e6);
        manager.initialize(key, price);
        int24 tick = TickMath.getTickAtSqrtPrice(price) / 60 * 60;
        lower = tick - 6000;
        upper = tick + 6000;
        _liquidity(int256(uint256(SEED)));
        _health();
    }

    function _liquidity(int256 amount) private {
        liquidity.modifyLiquidity(key, ModifyLiquidityParams(lower, upper, amount, 0), "");
    }

    function _advance(uint256 seconds_) private {
        vm.warp(vm.getBlockTimestamp() + seconds_);
        vm.roll(vm.getBlockNumber() + 1);
    }

    function _health() private {
        health.publish(health.sequence() + 1, true, uint64(block.timestamp + 300));
    }

    function _warm() private {
        _advance(300);
        hook.checkpoint();
        _health();
    }

    function _buy(uint128 amount) private returns (uint256) {
        vm.prank(trader);
        return router.swap(false, amount, 100e6);
    }

    function _tick() private view returns (int24 value) {
        (, value,,) = IPoolManager(address(manager)).getSlot0(key.toId());
    }

    function _atomicFailure(uint128 amount) private {
        _atomicFailure(amount, "", false);
    }

    function _atomicFailure(uint128 amount, string memory reason, bool afterSwap) private {
        uint256 cityBefore = city.balanceOf(trader);
        uint256 usdcBefore = usdc.balanceOf(trader);
        int24 tickBefore = _tick();
        uint128 used = hook.cityOutputThisBlock();
        int192 cumulative = hook.tickCumulative();
        if (bytes(reason).length == 0) {
            vm.expectRevert();
        } else {
            vm.expectRevert(
                abi.encodeWithSelector(
                    CustomRevert.WrappedError.selector,
                    address(hook),
                    afterSwap ? hook.afterSwap.selector : hook.beforeSwap.selector,
                    abi.encodeWithSignature("Error(string)", reason),
                    abi.encodeWithSelector(Hooks.HookCallFailed.selector)
                )
            );
        }
        vm.prank(trader);
        router.swap(false, amount, 100e6);
        assertEq(city.balanceOf(trader), cityBefore);
        assertEq(usdc.balanceOf(trader), usdcBefore);
        assertEq(_tick(), tickBefore);
        assertEq(hook.cityOutputThisBlock(), used);
        assertEq(hook.tickCumulative(), cumulative);
    }

    function testBootstrapCannotBeFabricatedInSameBlock() public {
        (bool ready,,,) = hook.marketReference();
        assertFalse(ready);
        hook.checkpoint();
        hook.checkpoint();
        vm.roll(block.number + 10);
        (ready,,,) = hook.marketReference();
        assertFalse(ready);
        _atomicFailure(1e18);
        _advance(299);
        hook.checkpoint();
        (ready,,,) = hook.marketReference();
        assertFalse(ready);
        _advance(1);
        _health();
        (ready,,,) = hook.marketReference();
        assertTrue(ready);
        _buy(1e18);
    }

    function testOfficialQuoteAndBothDecimalDirectionsMatchActualExecution() public {
        _warm();
        uint128 output = 1e18;
        uint128 used = hook.cityOutputThisBlock();
        int192 cumulative = hook.tickCumulative();
        (uint256 quote,) =
            quoter.quoteExactOutputSingle(IV4Quoter.QuoteExactSingleParams(key, false, output, abi.encode(trader)));
        assertEq(hook.cityOutputThisBlock(), used);
        assertEq(hook.tickCumulative(), cumulative);
        assertGe(quote, 1e6);
        assertLt(quote, 1020000);
        assertEq(_buy(output), quote);
        (quote,) = quoter.quoteExactOutputSingle(IV4Quoter.QuoteExactSingleParams(key, true, 1e6, abi.encode(trader)));
        assertGe(quote, 0.99e18);
        assertLt(quote, 1.02e18);
        vm.prank(trader);
        assertEq(router.swap(true, 1e6, 2e18), quote);
    }

    function testTimeWeightedTicksUseRealElapsedTimeAndFloorNegativeMeans() public {
        int24 initial = hook.priorTick();
        assertLt(initial, 0);
        _warm();
        _buy(1e18);
        int24 afterTrade = hook.priorTick();
        assertGt(afterTrade, initial);
        _advance(1);
        hook.checkpoint();
        (bool ready, int24 actual, uint64 anchor, uint64 age) = hook.marketReference();
        int256 sum = int256(initial) * 300 + afterTrade;
        int256 expected = sum / 301;
        if (sum < 0 && sum % 301 != 0) expected--;
        assertTrue(ready);
        assertEq(anchor, 1000);
        assertEq(age, 301);
        assertEq(actual, expected);
        assertEq(hook.tickCumulative(), sum);
        assertNotEq(sum % 301, 0);
    }

    function testSizeAndPerBlockCapsRevertWithoutChangingBalancesOrHistory() public {
        _warm();
        _atomicFailure(10e18 + 1);
        _buy(10e18);
        _buy(10e18);
        assertEq(hook.cityOutputThisBlock(), 20e18);
        _atomicFailure(1e18, "block CITY cap", false);
        vm.roll(block.number + 1);
        _buy(1e18);
        assertEq(hook.cityOutputThisBlock(), 1e18);
        vm.prank(trader);
        router.swap(true, 10e6, 20e18);
        vm.prank(trader);
        router.swap(true, 10e6, 20e18);
        assertEq(hook.usdcOutputThisBlock(), 20e6);
        vm.expectRevert();
        vm.prank(trader);
        router.swap(true, 1e6, 2e18);
        vm.roll(block.number + 1);
        vm.expectRevert();
        vm.prank(trader);
        router.swap(true, 10e6 + 1, 20e18);
    }

    function testLiquidityLossResetsCoverageAndPriceImpactIsBounded() public {
        _warm();
        hook.setPaused(true);
        _liquidity(-int256(uint256(SEED)));
        assertEq(hook.activeLiquidity(), 0);
        assertEq(hook.liquidSince(), 0);
        hook.setPaused(false);
        _atomicFailure(1e18);
        _liquidity(int256(uint256(FLOOR)));
        (bool ready,,,) = hook.marketReference();
        assertFalse(ready);
        _advance(300);
        hook.checkpoint();
        _health();
        (ready,,,) = hook.marketReference();
        assertTrue(ready);
        _atomicFailure(5e18, "trade price impact", true); // At this real active depth, 5 CITY moves the tick by about 100.
        _buy(1e18);
    }

    function testEffectivePriceIncludesFeesAndMarketFeeHasNoUserTiers() public {
        _warm();
        for (uint256 index; index < 5; index++) {
            vm.roll(vm.getBlockNumber() + 1);
            _buy(10e18);
        }
        assertEq(hook.feeFor(trader), hook.MAX_FEE());
        assertEq(hook.feeFor(address(0xDEAD)), hook.MAX_FEE());
        int24 initial = TickMath.getTickAtSqrtPrice(uint160((uint256(1) << 96) / 1e6));
        assertLt(int256(_tick()) - int256(initial), int256(uint256(hook.MAX_DEVIATION_TICKS())));
        vm.roll(block.number + 1);
        _atomicFailure(10e18, "execution outside reference", true);
    }

    function testStaleAnchorsFailClosedAndCheckpointRestoresAFullWindow() public {
        _advance(601);
        hook.checkpoint();
        _health();
        (bool ready,,,) = hook.marketReference();
        assertFalse(ready);
        _atomicFailure(1e18);
        _advance(300);
        hook.checkpoint();
        _health();
        (ready,,,) = hook.marketReference();
        assertTrue(ready);
        _buy(1e18);
    }

    function testRouterAuthorityPauseAndHealthKeepLPWithdrawalAvailable() public {
        _warm();
        MarketplaceRouterFixture other = new MarketplaceRouterFixture(manager, address(hook), key);
        vm.expectRevert();
        vm.prank(trader);
        other.swap(false, 1e18, 10e6);
        vm.expectRevert();
        vm.prank(trader);
        hook.setPaused(true);
        vm.expectRevert();
        hook.bindRouter(address(other));
        hook.setPaused(true);
        _atomicFailure(1e18);
        _liquidity(-int256(uint256(SEED / 10)));
        hook.setPaused(false);
        health.publish(health.sequence() + 1, false, uint64(block.timestamp + 300));
        _atomicFailure(1e18);
        vm.prank(trader);
        router.swap(true, 1e6, 2e18);
    }

    function testObservationRingRemainsBoundedWithRealPoolState() public {
        for (uint256 index; index < 70; index++) {
            _advance(30);
            hook.checkpoint();
        }
        assertEq(hook.observationCount(), 64);
        assertLt(hook.nextObservation(), 64);
        (bool ready, int24 mean,, uint64 age) = hook.marketReference();
        assertTrue(ready);
        assertEq(mean, hook.priorTick());
        assertGe(age, 300);
        assertLe(age, 600);
    }
}
