// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.26;

import {AgentCityTest} from "./AgentCity.t.sol";
import {WorldAssetSwapRouter} from "agentcity/WorldAssetSwapRouter.sol";
import {PlayableMarketRouter} from "agentcity/PlayableMarketRouter.sol";
import {V4Quoter} from "@uniswap/v4-periphery/src/lens/V4Quoter.sol";
import {IV4Quoter} from "@uniswap/v4-periphery/src/interfaces/IV4Quoter.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {ModifyLiquidityParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";

/// Real v4 swaps with disclosed synthetic tokens; no public funds or game effects.
contract ExactOutputSwapTest is AgentCityTest {
    function approveRoute(address router) internal {
        cred.approve(router, 100e18);
        kit.approve(router, 100e18);
    }

    function quotedInput(bool zeroForOne, uint128 amountOut) internal returns (uint256 amountIn) {
        V4Quoter quoter = new V4Quoter(manager);
        (amountIn,) = quoter.quoteExactOutputSingle(IV4Quoter.QuoteExactSingleParams({
            poolKey: key, zeroForOne: zeroForOne, exactAmount: amountOut, hookData: ""
        }));
    }

    function testExactOutputHookedBothDirectionsConserveBalancesAndReplay() public {
        WorldAssetSwapRouter router = new WorldAssetSwapRouter(manager, key);
        approveRoute(address(router));
        assertTrue(router.supportsExactOutput());
        for (uint256 index; index < 2; index++) {
            bool credIn = index == 0;
            bool zeroForOne = Currency.unwrap(key.currency0) == address(cred) ? credIn : !credIn;
            uint128 amountOut = 0.01e18;
            uint256 quote = quotedInput(zeroForOne, amountOut);
            uint128 maximum = uint128(quote + quote / 100 + 1);
            uint256 beforeCred = cred.balanceOf(address(this));
            uint256 beforeKit = kit.balanceOf(address(this));
            bytes32 operation = keccak256(abi.encode("exact-output", index));
            uint256 spent = router.swapExactOutput(operation, zeroForOne, amountOut, maximum, uint48(block.timestamp + 60));
            assertEq(spent, quote);
            assertLt(spent, maximum);
            assertEq(cred.balanceOf(address(this)), credIn ? beforeCred - spent : beforeCred + amountOut);
            assertEq(kit.balanceOf(address(this)), credIn ? beforeKit + amountOut : beforeKit - spent);
            assertEq(cred.balanceOf(address(router)), 0);
            assertEq(kit.balanceOf(address(router)), 0);
            vm.expectRevert("operation used");
            router.swapExactOutput(operation, zeroForOne, amountOut, maximum, uint48(block.timestamp + 60));
            vm.expectRevert("operation used");
            router.swapExactInput(operation, zeroForOne, 1, 1, uint48(block.timestamp + 60));
        }
    }

    function testExactOutputMaximumAndExpiryRefuseWithoutSpending() public {
        WorldAssetSwapRouter router = new WorldAssetSwapRouter(manager, key);
        approveRoute(address(router));
        bool direction = Currency.unwrap(key.currency0) == address(cred);
        bytes32 operation = keccak256("insufficient-maximum");
        uint256 beforeCred = cred.balanceOf(address(this));
        uint256 beforeKit = kit.balanceOf(address(this));
        vm.expectRevert("maximum input");
        router.swapExactOutput(operation, direction, 0.01e18, 1, uint48(block.timestamp + 60));
        assertFalse(router.operationUsed(address(this), operation));
        vm.expectRevert("quote expired");
        router.swapExactOutput(operation, direction, 0.01e18, 1e18, uint48(block.timestamp));
        assertEq(cred.balanceOf(address(this)), beforeCred);
        assertEq(kit.balanceOf(address(this)), beforeKit);
    }

    function testExactOutputRetainsTheHookHealthGate() public {
        WorldAssetSwapRouter router = new WorldAssetSwapRouter(manager, key);
        approveRoute(address(router));
        uint256 beforeCred = cred.balanceOf(address(this));
        uint256 future = vm.getBlockTimestamp() + 300;
        vm.warp(future);
        bytes32 operation = keccak256("stale-exact-output");
        vm.expectRevert();
        router.swapExactOutput(operation, Currency.unwrap(key.currency0) == address(cred), 0.01e18, 1e18, uint48(future + 60));
        assertFalse(router.operationUsed(address(this), operation));
        assertEq(cred.balanceOf(address(this)), beforeCred);
    }

    function testExactOutputPlainPoolUsesOfficialQuoterAndSameBounds() public {
        key.hooks = IHooks(address(0));
        manager.initialize(key, uint160(1 << 96));
        liquidityRouter.modifyLiquidity(key, ModifyLiquidityParams(-600, 600, 100e18, bytes32(0)), "");
        PlayableMarketRouter router = new PlayableMarketRouter(manager, key);
        approveRoute(address(router));
        bool direction = Currency.unwrap(key.currency0) == address(cred);
        uint256 quote = quotedInput(direction, 0.01e18);
        uint256 beforeCred = cred.balanceOf(address(this));
        uint256 beforeKit = kit.balanceOf(address(this));
        uint256 spent = router.swapExactOutput(keccak256("plain-exact-output"), direction, 0.01e18,
            uint128(quote + quote / 100 + 1), uint48(block.timestamp + 60));
        assertEq(spent, quote);
        assertEq(cred.balanceOf(address(this)), beforeCred - spent);
        assertEq(kit.balanceOf(address(this)), beforeKit + 0.01e18);
        assertTrue(router.supportsExactOutput());
        vm.expectRevert("maximum input");
        router.swapExactOutput(keccak256("plain-cap"), direction, 0.01e18, 1, uint48(block.timestamp + 60));
    }
}
