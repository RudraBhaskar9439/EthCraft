// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.26;
import {AgentCityTest} from "./AgentCity.t.sol";
import {WorldAssetSwapRouter} from "agentcity/WorldAssetSwapRouter.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";

/// Actual official v4 execution with disclosed synthetic ERC20 fixture assets.
contract WorldAssetSwapRouterTest is AgentCityTest {
    WorldAssetSwapRouter internal paymentRouter;
    function preparePaymentRoute() internal {
        paymentRouter=new WorldAssetSwapRouter(manager,key);
        cred.approve(address(paymentRouter),100e18);
    }
    function testWorldHookedSwapConservesInputAndReturnsOutputOnce() public {
        preparePaymentRoute();
        uint256 beforeIn=cred.balanceOf(address(this));uint256 beforeOut=kit.balanceOf(address(this));
        bytes32 operation=keccak256("world-asset-swap");
        uint256 received=paymentRouter.swapExactInput(operation,Currency.unwrap(key.currency0)==address(cred),1e18,1,uint48(block.timestamp+120));
        assertGt(received,0);assertEq(cred.balanceOf(address(this)),beforeIn-1e18);assertEq(kit.balanceOf(address(this)),beforeOut+received);
        assertTrue(paymentRouter.operationUsed(address(this),operation));
        vm.expectRevert("operation used");paymentRouter.swapExactInput(operation,true,1e18,1,uint48(block.timestamp+120));
        assertEq(cred.balanceOf(address(this)),beforeIn-1e18);
    }
    function testWorldStaleHookRefusesWithoutSpendingAndRetainsOperation() public {
        preparePaymentRoute();
        uint256 beforeIn=cred.balanceOf(address(this));bytes32 operation=keccak256("world-stale-swap");
        uint256 future=vm.getBlockTimestamp()+300;vm.warp(future);vm.expectRevert();
        paymentRouter.swapExactInput(operation,Currency.unwrap(key.currency0)==address(cred),1e18,1,uint48(future+120));
        assertEq(cred.balanceOf(address(this)),beforeIn);assertFalse(paymentRouter.operationUsed(address(this),operation));
        vm.prank(PUBLISHER);registry.publish(2,true,uint64(future+300));
        assertGt(paymentRouter.swapExactInput(operation,Currency.unwrap(key.currency0)==address(cred),1e18,1,uint48(future+120)),0);
    }
    function testWorldHookRequiredAndMinimumOutputCannotSpend() public {
        preparePaymentRoute();
        key.hooks=IHooks(address(0));vm.expectRevert("hooked test pool");new WorldAssetSwapRouter(manager,key);
        uint256 beforeIn=cred.balanceOf(address(this));vm.expectRevert();
        paymentRouter.swapExactInput(keccak256("minimum-output"),Currency.unwrap(key.currency0)==address(cred),1e18,type(uint128).max,uint48(block.timestamp+120));
        assertEq(cred.balanceOf(address(this)),beforeIn);
    }
}
