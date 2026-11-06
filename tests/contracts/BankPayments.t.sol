// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {PoolManager} from "@uniswap/v4-core/src/PoolManager.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {ModifyLiquidityParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {PoolModifyLiquidityTest} from "@uniswap/v4-core/src/test/PoolModifyLiquidityTest.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {V4Quoter} from "@uniswap/v4-periphery/src/lens/V4Quoter.sol";
import {IV4Quoter} from "@uniswap/v4-periphery/src/interfaces/IV4Quoter.sol";
import {PathKey} from "@uniswap/v4-periphery/src/libraries/PathKey.sol";
import {PlayableMarketToken} from "agentcity/PlayableMarketToken.sol";
import {BankTestUSDC} from "agentcity/BankTestUSDC.sol";
import {WorldAssetRegistry} from "agentcity/WorldAssetRegistry.sol";
import {WorldAssetMarket} from "agentcity/WorldAssetMarket.sol";
import {StateRegistry} from "agentcity/StateRegistry.sol";
import {AgentCityBank} from "agentcity/AgentCityBank.sol";
import {AgentCityReputationHook} from "agentcity/AgentCityReputationHook.sol";
import {BankPaymentRouter} from "agentcity/BankPaymentRouter.sol";
import {AgentCityWorkEscrow} from "agentcity/AgentCityWorkEscrow.sol";

contract BankPaymentsTest is Test {
    PlayableMarketToken city;
    PlayableMarketToken gem;
    BankTestUSDC usdc;
    WorldAssetRegistry assets;
    WorldAssetMarket market;
    StateRegistry health;
    AgentCityBank bank;
    AgentCityReputationHook hook;
    BankPaymentRouter router;
    AgentCityWorkEscrow work;
    PoolManager manager;
    PoolModifyLiquidityTest liquidity;
    V4Quoter quoter;
    PoolKey mainPool;
    PoolKey gemPool;
    address buyer = address(0xB0B);
    address seller = address(0x5E11);
    address issuer = address(0x1550);
    address registrar = address(0xAAA);
    address inspector = address(0xBBB);
    address lender = address(0xCCC);

    function setUp() public {
        vm.chainId(31337);
        vm.warp(1000);
        city = new PlayableMarketToken("Laptop Test CITY", "CITY", address(this), issuer, 1_000_000e18);
        gem = new PlayableMarketToken("Laptop Test GEM", "GEM", address(this), issuer, 1_000_000e18);
        usdc = new BankTestUSDC(address(this), issuer);
        assets = new WorldAssetRegistry(address(this), registrar);
        market = new WorldAssetMarket(assets, city);
        bank = new AgentCityBank(assets, usdc, lender);
        work = new AgentCityWorkEscrow(city, inspector);
        manager = new PoolManager(address(this));
        quoter = new V4Quoter(manager);
        health = new StateRegistry(address(this), keccak256("laptop-bank"));
        address where = address(0xB00080);
        deployCodeTo(
            "AgentCityReputationHook.sol:AgentCityReputationHook",
            abi.encode(manager, health, bank, quoter, address(this), address(city), address(usdc)),
            where
        );
        hook = AgentCityReputationHook(where);
        mainPool = _key(address(city), address(usdc), 0x800000, IHooks(where));
        gemPool = _key(address(gem), address(usdc), 3000, IHooks(address(0)));
        router = new BankPaymentRouter(manager, market, usdc, mainPool, gemPool);
        hook.bindRouter(address(router));
        liquidity = new PoolModifyLiquidityTest(manager);
        vm.startPrank(issuer);
        city.mint(address(this), 100_000e18);
        gem.mint(address(this), 100_000e18);
        usdc.mint(address(this), 100_000e6);
        city.mint(buyer, 100e18);
        gem.mint(buyer, 100e18);
        usdc.mint(buyer, 100e6);
        vm.stopPrank();
        city.approve(address(liquidity), type(uint256).max);
        gem.approve(address(liquidity), type(uint256).max);
        usdc.approve(address(liquidity), type(uint256).max);
        _seed(mainPool, address(city));
        _seed(gemPool, address(gem));
        health.publish(1, true, uint64(block.timestamp + 300));
        vm.startPrank(buyer);
        city.approve(address(router), 100e18);
        gem.approve(address(router), 100e18);
        usdc.approve(address(router), 100e6);
        city.approve(address(work), 100e18);
        vm.stopPrank();
    }

    function _key(address a, address b, uint24 fee, IHooks h) private pure returns (PoolKey memory) {
        return PoolKey(Currency.wrap(a < b ? a : b), Currency.wrap(a < b ? b : a), fee, 60, h);
    }

    function _seed(PoolKey memory key, address coin) private {
        uint160 price = uint160(address(coin) < address(usdc) ? (uint256(1) << 96) / 1e6 : (uint256(1) << 96) * 1e6);
        manager.initialize(key, price);
        int24 tick = TickMath.getTickAtSqrtPrice(price) / 60 * 60;
        liquidity.modifyLiquidity(key, ModifyLiquidityParams(tick - 6000, tick + 6000, 10_000e12, 0), "");
    }

    function _quote(address input, address output, uint128 amount) private returns (uint256 result) {
        if (input == address(usdc) || output == address(usdc)) {
            PoolKey memory key = input == address(city) || output == address(city) ? mainPool : gemPool;
            (result,) = quoter.quoteExactOutputSingle(
                IV4Quoter.QuoteExactSingleParams(
                    key, input == Currency.unwrap(key.currency0), amount, abi.encode(buyer)
                )
            );
        } else {
            PathKey[] memory path = new PathKey[](2);
            PoolKey memory outKey = output == address(city) ? mainPool : gemPool;
            PoolKey memory inKey = input == address(city) ? mainPool : gemPool;
            // The official exact-output quoter walks this array backwards.
            path[0] = PathKey(Currency.wrap(input), inKey.fee, 60, inKey.hooks, abi.encode(buyer));
            path[1] = PathKey(Currency.wrap(address(usdc)), outKey.fee, 60, outKey.hooks, abi.encode(buyer));
            (result,) = quoter.quoteExactOutput(IV4Quoter.QuoteExactParams(Currency.wrap(output), path, amount));
        }
    }

    function _listing() private returns (BankPaymentRouter.Checkout memory terms) {
        vm.prank(registrar);
        uint256 token = assets.mintItem(
            seller,
            keccak256("laptop"),
            keccak256("world"),
            keccak256("custody"),
            keccak256("exact-enchanted-sword"),
            keccak256("native-receipt")
        );
        WorldAssetRegistry.Asset memory a = assets.asset(token);
        vm.startPrank(seller);
        assets.approve(address(market), token);
        uint256 nonce = market.list(token, 5e18, uint64(block.timestamp + 600), a.ownershipNonce, a.revision);
        vm.stopPrank();
        return BankPaymentRouter.Checkout(token, seller, 5e18, nonce, a.ownershipNonce, a.revision);
    }

    function testOfficialQuoterAndThreeTokenRoutesConserveExactAmounts() public {
        address[4] memory inputs = [address(usdc), address(city), address(gem), address(city)];
        address[4] memory outputs = [address(city), address(usdc), address(city), address(gem)];
        for (uint256 i; i < 4; i++) {
            uint128 out = outputs[i] == address(usdc) ? 1e6 : 1e18;
            uint256 quoted = _quote(inputs[i], outputs[i], out);
            uint256 beforeIn = PlayableMarketToken(inputs[i]).balanceOf(buyer);
            uint256 beforeOut = PlayableMarketToken(outputs[i]).balanceOf(buyer);
            vm.prank(buyer);
            uint256 actual = router.swapExactOutput(
                keccak256(abi.encode(i)),
                inputs[i],
                outputs[i],
                out,
                uint128(quoted + quoted / 100 + 1),
                uint48(block.timestamp + 60)
            );
            assertEq(actual, quoted);
            assertEq(PlayableMarketToken(inputs[i]).balanceOf(buyer), beforeIn - actual);
            assertEq(PlayableMarketToken(outputs[i]).balanceOf(buyer), beforeOut + out);
            assertEq(city.balanceOf(address(router)), 0);
            assertEq(usdc.balanceOf(address(router)), 0);
            assertEq(gem.balanceOf(address(router)), 0);
        }
    }

    function testSwapAndBuyDeliversExactNftAndActualSellerPrice() public {
        BankPaymentRouter.Checkout memory terms = _listing();
        uint256 quote = _quote(address(gem), address(city), terms.price);
        uint256 beforeGem = gem.balanceOf(buyer);
        vm.prank(buyer);
        uint256 spent = router.buyWithSwap(
            keccak256("checkout"), address(gem), uint128(quote + 1e16), uint48(block.timestamp + 60), terms
        );
        assertEq(spent, quote);
        assertEq(gem.balanceOf(buyer), beforeGem - spent);
        assertEq(city.balanceOf(seller), terms.price);
        assertEq(assets.ownerOf(terms.tokenId), buyer);
        assertEq(assets.asset(terms.tokenId).ownershipNonce, terms.ownershipNonce + 2);
        assertEq(city.allowance(address(router), address(market)), 0);
        assertEq(city.balanceOf(address(router)), 0);
        vm.prank(buyer);
        vm.expectRevert("operation used");
        router.buyWithSwap(
            keccak256("checkout"), address(gem), uint128(quote + 1e16), uint48(block.timestamp + 60), terms
        );
    }

    function testChangedListingRevertsTheEntireSwap() public {
        BankPaymentRouter.Checkout memory terms = _listing();
        uint256 quote = _quote(address(usdc), address(city), terms.price);
        vm.prank(seller);
        market.cancel(terms.tokenId, terms.listingNonce);
        uint256 beforeUsdc = usdc.balanceOf(buyer);
        vm.prank(buyer);
        vm.expectRevert("listing terms changed");
        router.buyWithSwap(keccak256("stale"), address(usdc), uint128(quote + 1e5), uint48(block.timestamp + 60), terms);
        assertEq(usdc.balanceOf(buyer), beforeUsdc);
        assertEq(assets.ownerOf(terms.tokenId), seller);
        assertEq(city.balanceOf(seller), 0);
        assertFalse(router.operationUsed(buyer, keccak256("stale")));
    }

    function testInputCapAndStaleHealthCannotSpend() public {
        uint256 beforeUsdc = usdc.balanceOf(buyer);
        vm.prank(buyer);
        vm.expectRevert("maximum input");
        router.swapExactOutput(keccak256("cap"), address(usdc), address(city), 1e18, 1, uint48(block.timestamp + 60));
        vm.warp(block.timestamp + 300);
        vm.prank(buyer);
        vm.expectRevert();
        router.swapExactOutput(
            keccak256("stale-health"), address(usdc), address(city), 1e18, 5e6, uint48(block.timestamp + 60)
        );
        assertEq(usdc.balanceOf(buyer), beforeUsdc);
    }

    function testWorkNeedsFundingInspectionAndRequesterAcceptance() public {
        bytes32 id = keccak256("work");
        bytes32 terms = keccak256("immutable-quote");
        bytes32 result = keccak256("native-result");
        vm.prank(buyer);
        work.fundWork(id, seller, terms, 3e18, uint48(block.timestamp + 600), 120);
        vm.prank(seller);
        vm.expectRevert("funded native start required");
        work.startWork(id, terms);
        vm.prank(inspector);
        work.startWork(id, terms);
        vm.prank(buyer);
        vm.expectRevert("requester accepts current result");
        work.acceptWork(id, terms, result);
        vm.prank(inspector);
        work.recordCompletion(id, terms, result);
        vm.prank(seller);
        vm.expectRevert("requester accepts current result");
        work.acceptWork(id, terms, result);
        vm.prank(buyer);
        work.acceptWork(id, terms, result);
        assertEq(city.balanceOf(seller), 3e18);
        assertEq(city.balanceOf(address(work)), 0);
        vm.prank(buyer);
        vm.expectRevert("requester accepts current result");
        work.acceptWork(id, terms, result);
    }

    function testCompletedWorkKeepsReviewWindowAndExclusiveRefund() public {
        bytes32 id = keccak256("review");
        bytes32 terms = keccak256("quote");
        bytes32 result = keccak256("result");
        uint48 deadline = uint48(block.timestamp + 60);
        vm.prank(buyer);
        work.fundWork(id, seller, terms, 3e18, deadline, 120);
        vm.startPrank(inspector);
        work.startWork(id, terms);
        work.recordCompletion(id, terms, result);
        vm.stopPrank();
        vm.warp(deadline);
        vm.prank(buyer);
        vm.expectRevert("work or review still valid");
        work.refundWork(id);
        vm.warp(uint256(deadline) + 120);
        vm.prank(buyer);
        work.refundWork(id);
        assertEq(city.balanceOf(buyer), 100e18);
        vm.prank(buyer);
        vm.expectRevert("requester accepts current result");
        work.acceptWork(id, terms, result);
        assertEq(city.balanceOf(seller), 0);
    }
}
