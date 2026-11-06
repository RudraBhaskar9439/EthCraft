// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.26;

import {AgentCityBankFixture} from "./AgentCityBank.t.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeCallback} from "@uniswap/v4-periphery/src/base/SafeCallback.sol";
import {PoolManager} from "@uniswap/v4-core/src/PoolManager.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {LPFeeLibrary} from "@uniswap/v4-core/src/libraries/LPFeeLibrary.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {SwapParams, ModifyLiquidityParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {PoolSwapTest} from "@uniswap/v4-core/src/test/PoolSwapTest.sol";
import {PoolModifyLiquidityTest} from "@uniswap/v4-core/src/test/PoolModifyLiquidityTest.sol";
import {V4Quoter} from "@uniswap/v4-periphery/src/lens/V4Quoter.sol";
import {IV4Quoter} from "@uniswap/v4-periphery/src/interfaces/IV4Quoter.sol";
import {Vm} from "forge-std/Vm.sol";
import {StateRegistry} from "agentcity/StateRegistry.sol";
import {AgentCityReputationHook} from "agentcity/AgentCityReputationHook.sol";

contract BankCITYFixture is ERC20 {
    constructor() ERC20("Disclosed bank CITY fixture", "CITY") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

/// Fixture follows the production authentication boundary: no external payer
/// parameter, only the wallet that called the router can spend or get its fee.
contract BankAuthenticatedRouterFixture is SafeCallback {
    PoolKey private _key;
    address public immutable hook;

    constructor(IPoolManager manager, PoolKey memory key) SafeCallback(manager) {
        _key = key;
        hook = address(key.hooks);
    }

    function swap(bool zeroForOne, uint128 amountIn, uint128 minimumOut) external returns (uint256) {
        return abi.decode(poolManager.unlock(abi.encode(msg.sender, zeroForOne, amountIn, minimumOut)), (uint256));
    }

    function _unlockCallback(bytes calldata data) internal override returns (bytes memory) {
        (address payer, bool direction, uint128 amountIn, uint128 minimumOut) =
            abi.decode(data, (address, bool, uint128, uint128));
        BalanceDelta delta = poolManager.swap(
            _key,
            SwapParams(
                direction,
                -int256(uint256(amountIn)),
                direction ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1
            ),
            abi.encode(payer)
        );
        int128 input = direction ? delta.amount0() : delta.amount1();
        int128 output = direction ? delta.amount1() : delta.amount0();
        require(
            input < 0 && uint256(-int256(input)) == amountIn && output > 0 && uint128(output) >= minimumOut,
            "fixture swap bounds"
        );
        Currency currencyIn = direction ? _key.currency0 : _key.currency1;
        Currency currencyOut = direction ? _key.currency1 : _key.currency0;
        poolManager.sync(currencyIn);
        IERC20(Currency.unwrap(currencyIn)).transferFrom(payer, address(poolManager), amountIn);
        require(poolManager.settle() == amountIn, "fixture settlement");
        poolManager.take(currencyOut, payer, uint128(output));
        return abi.encode(uint256(uint128(output)));
    }
}

/// Official v4 execution with fixture assets; no public liquidity or native
/// custody is claimed by these isolated history/fee tests.
contract AgentCityReputationHookTest is AgentCityBankFixture {
    address private constant PUBLISHER = address(0xB11);
    PoolManager private manager;
    StateRegistry private availability;
    AgentCityReputationHook private hook;
    V4Quoter private quoter;
    BankAuthenticatedRouterFixture private router;
    PoolKey private key;
    BankCITYFixture private city;

    function setUp() public override {
        super.setUp();
        manager = new PoolManager(address(this));
        availability = new StateRegistry(PUBLISHER, keccak256("owned bank fixture market"));
        city = new BankCITYFixture();
        quoter = new V4Quoter(manager);
        address hookAddress = address(uint160(Hooks.BEFORE_SWAP_FLAG));
        deployCodeTo(
            "AgentCityReputationHook.sol:AgentCityReputationHook",
            abi.encode(manager, availability, bank, address(quoter), ADMIN, address(city), address(usdc)),
            hookAddress
        );
        hook = AgentCityReputationHook(hookAddress);
        key = PoolKey({
            currency0: Currency.wrap(address(usdc) < address(city) ? address(usdc) : address(city)),
            currency1: Currency.wrap(address(usdc) < address(city) ? address(city) : address(usdc)),
            fee: LPFeeLibrary.DYNAMIC_FEE_FLAG,
            tickSpacing: 60,
            hooks: IHooks(hookAddress)
        });
        manager.initialize(key, uint160(1 << 96));
        router = new BankAuthenticatedRouterFixture(manager, key);
        vm.prank(ADMIN);
        hook.bindRouter(address(router));
        PoolModifyLiquidityTest liquidity = new PoolModifyLiquidityTest(manager);
        usdc.mint(address(this), 1000e6);
        city.mint(address(this), 1000e18);
        usdc.approve(address(liquidity), type(uint256).max);
        city.approve(address(liquidity), type(uint256).max);
        liquidity.modifyLiquidity(key, ModifyLiquidityParams(-600, 600, 100e6, bytes32(0)), "");
        address[3] memory wallets = [BORROWER, BIDDER, OTHER];
        for (uint256 index; index < wallets.length; index++) {
            city.mint(wallets[index], 1e18);
            vm.prank(wallets[index]);
            usdc.approve(address(router), type(uint256).max);
            vm.prank(wallets[index]);
            city.approve(address(router), type(uint256).max);
        }
        vm.prank(PUBLISHER);
        availability.publish(1, true, uint64(block.timestamp + 300));
    }

    function qualifyBorrower() private {
        for (uint256 index; index < 2; index++) {
            uint256 tokenId = item(BORROWER);
            bytes32 id = keccak256(abi.encode("qualified loan", index));
            take(id, tokenId);
            vm.warp(bank.loan(id).dueAt);
            vm.prank(BORROWER);
            bank.repay(id);
        }
    }

    function quotedInput(address payer) private returns (uint256) {
        (uint256 amount,) = quoter.quoteExactOutputSingle(
            IV4Quoter.QuoteExactSingleParams({
                poolKey: key,
                zeroForOne: Currency.unwrap(key.currency0) == address(usdc),
                exactAmount: 100_000,
                hookData: abi.encode(payer)
            })
        );
        return amount;
    }

    function actualSwapFee(address payer) private returns (uint24 fee) {
        vm.recordLogs();
        vm.prank(payer);
        router.swap(Currency.unwrap(key.currency0) == address(usdc), 100_000, 1);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        bytes32 swapTopic = keccak256("Swap(bytes32,address,int128,int128,uint160,uint128,int24,uint24)");
        for (uint256 index; index < logs.length; index++) {
            if (logs[index].emitter == address(manager) && logs[index].topics[0] == swapTopic) {
                (,,,,, fee) = abi.decode(logs[index].data, (int128, int128, uint160, uint128, int24, uint24));
                return fee;
            }
        }
        revert("official swap event missing");
    }

    function testOfficialQuoteAndRealSwapUseOnlyActualWalletHistory() public {
        uint256 standardQuote = quotedInput(BORROWER);
        assertEq(hook.feeFor(BORROWER), 3000);
        qualifyBorrower();
        assertEq(hook.feeFor(BORROWER), 2500);
        assertEq(hook.feeFor(OTHER), 3000);
        assertLt(quotedInput(BORROWER), standardQuote);
        assertEq(quotedInput(OTHER), standardQuote);
        assertEq(actualSwapFee(OTHER), 3000);
        assertEq(actualSwapFee(BORROWER), 2500);
        assertEq(usdc.balanceOf(address(router)), 0);
        assertEq(city.balanceOf(address(router)), 0);
        assertCashAccounted();
    }

    function testForeignRouterCannotBorrowAnotherWalletFeeOrCallHookDirectly() public {
        qualifyBorrower();
        PoolSwapTest attacker = new PoolSwapTest(manager);
        vm.prank(OTHER);
        usdc.approve(address(attacker), type(uint256).max);
        uint256 beforeBalance = usdc.balanceOf(OTHER);
        vm.expectRevert();
        vm.prank(OTHER);
        attacker.swap(
            key,
            SwapParams(
                Currency.unwrap(key.currency0) == address(usdc),
                -int256(100_000),
                Currency.unwrap(key.currency0) == address(usdc)
                    ? TickMath.MIN_SQRT_PRICE + 1
                    : TickMath.MAX_SQRT_PRICE - 1
            ),
            PoolSwapTest.TestSettings(false, false),
            abi.encode(BORROWER)
        );
        assertEq(usdc.balanceOf(OTHER), beforeBalance);
        vm.expectRevert();
        hook.beforeSwap(address(router), key, SwapParams(true, -1, TickMath.MIN_SQRT_PRICE + 1), abi.encode(BORROWER));
        assertEq(actualSwapFee(OTHER), 3000);
    }

    function testStaleUnavailableReportsHaltCityPurchasesButPreserveRepaymentExits() public {
        qualifyBorrower();
        bytes32 id = keccak256("discount borrower default");
        uint256 tokenId = item(BORROWER);
        take(id, tokenId);
        overdue(id);
        assertEq(hook.feeFor(BORROWER), 3000);
        uint256 current = vm.getBlockTimestamp();
        vm.prank(PUBLISHER);
        availability.publish(2, false, uint64(current + 300));
        uint256 beforeBalance = usdc.balanceOf(BORROWER);
        vm.expectRevert();
        vm.prank(BORROWER);
        router.swap(Currency.unwrap(key.currency0) == address(usdc), 100_000, 1);
        assertEq(usdc.balanceOf(BORROWER), beforeBalance);
        vm.prank(BORROWER);
        router.swap(Currency.unwrap(key.currency0) == address(city), 100_000, 1);
        assertGt(usdc.balanceOf(BORROWER), beforeBalance);
        vm.prank(PUBLISHER);
        availability.publish(3, true, uint64(current + 300));
        vm.warp(current + 300);
        vm.expectRevert();
        vm.prank(BORROWER);
        router.swap(Currency.unwrap(key.currency0) == address(usdc), 100_000, 1);
        beforeBalance = usdc.balanceOf(BORROWER);
        vm.prank(BORROWER);
        router.swap(Currency.unwrap(key.currency0) == address(city), 100_000, 1);
        assertGt(usdc.balanceOf(BORROWER), beforeBalance);
        vm.prank(PUBLISHER);
        availability.publish(4, true, uint64(vm.getBlockTimestamp() + 300));
        assertEq(actualSwapFee(BORROWER), 3000);
    }

    function testRouterBindingIsOneTimeAndStaticOrForeignPoolCannotUseHook() public {
        vm.expectRevert("one administrator router binding");
        vm.prank(OTHER);
        hook.bindRouter(address(router));
        vm.expectRevert("one administrator router binding");
        vm.prank(ADMIN);
        hook.bindRouter(address(router));
        PoolKey memory foreign = key;
        foreign.fee = 3000;
        vm.expectRevert("foreign reputation pool");
        vm.prank(address(manager));
        hook.beforeSwap(
            address(router), foreign, SwapParams(true, -1, TickMath.MIN_SQRT_PRICE + 1), abi.encode(BORROWER)
        );
        vm.expectRevert("payer hint required");
        vm.prank(address(manager));
        hook.beforeSwap(address(router), key, SwapParams(true, -1, TickMath.MIN_SQRT_PRICE + 1), "");
    }
}
