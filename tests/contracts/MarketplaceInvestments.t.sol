// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.26;

import {AgentCityMarketplaceHookTest} from "./AgentCityMarketplaceHook.t.sol";
import {PositionManager} from "@uniswap/v4-periphery/src/PositionManager.sol";
import {IPositionDescriptor} from "@uniswap/v4-periphery/src/interfaces/IPositionDescriptor.sol";
import {IWETH9} from "@uniswap/v4-periphery/src/interfaces/external/IWETH9.sol";
import {IAllowanceTransfer} from "permit2/src/interfaces/IAllowanceTransfer.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ModifyLiquidityParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";

// Isolated allowance-transfer fixture. Not evidence of Privy or public Permit2 execution.
contract InvestmentPermitFixture {
    struct Grant {uint160 amount; uint48 expiry;}
    mapping(address => mapping(address => mapping(address => Grant))) public grants;
    function approve(address token,address spender,uint160 amount,uint48 expiration) external {grants[msg.sender][token][spender]=Grant(amount,expiration);}
    function transferFrom(address from,address to,uint160 amount,address token) external {
        Grant storage g=grants[from][token][msg.sender];
        require(block.timestamp<=g.expiry&&amount<=g.amount,"permit bound");g.amount-=amount;
        require(IERC20(token).transferFrom(from,to,amount));
    }
}

contract MarketplaceInvestmentsTest is AgentCityMarketplaceHookTest {
    function _positionManager() private returns(PositionManager pm) {
        InvestmentPermitFixture permit=new InvestmentPermitFixture();
        pm=new PositionManager(manager,IAllowanceTransfer(address(permit)),100000,IPositionDescriptor(address(0)),IWETH9(address(0)));
        city.approve(address(permit),20e18);usdc.approve(address(permit),20e6);
        permit.approve(address(city),address(pm),20e18,uint48(vm.getBlockTimestamp()+1000));
        permit.approve(address(usdc),address(pm),20e6,uint48(vm.getBlockTimestamp()+1000));
    }
    function _mint(PositionManager pm) private returns(uint256 id) {
        id=pm.nextTokenId();
        bytes[] memory params=new bytes[](2);
        params[0]=abi.encode(key,lower,upper,uint256(1e13),uint128(20e18),uint128(20e6),address(this),bytes(""));
        params[1]=abi.encode(address(city),address(usdc));
        pm.modifyLiquidities(abi.encode(hex"020d",params),vm.getBlockTimestamp()+120);
    }
    function _remove(PositionManager pm,uint256 id,uint256 amount,uint128 minimum0,uint128 minimum1) private {
        bytes[] memory params=new bytes[](2);
        params[0]=abi.encode(id,amount,minimum0,minimum1,bytes(""));
        params[1]=abi.encode(address(city),address(usdc),address(this));
        pm.modifyLiquidities(abi.encode(hex"0111",params),vm.getBlockTimestamp()+120);
    }
    function testRealPositionManagerMintIncreaseFeesAndFullExitWhilePaused() public {
        PositionManager pm=_positionManager();uint256 id=_mint(pm);
        assertEq(pm.ownerOf(id),address(this));assertEq(pm.getPositionLiquidity(id),1e13);
        bytes[] memory params=new bytes[](2);
        params[0]=abi.encode(id,uint256(1e13),uint128(20e18),uint128(20e6),bytes(""));
        params[1]=abi.encode(address(city),address(usdc));
        pm.modifyLiquidities(abi.encode(hex"000d",params),vm.getBlockTimestamp()+120);
        assertEq(pm.getPositionLiquidity(id),2e13);
        vm.warp(vm.getBlockTimestamp()+300);vm.roll(vm.getBlockNumber()+1);hook.checkpoint();
        health.publish(health.sequence()+1,true,uint64(vm.getBlockTimestamp()+300));
        vm.prank(trader);router.swap(false,1e18,2e6);
        uint256 beforeFee=usdc.balanceOf(address(this));
        _remove(pm,id,0,0,0);
        assertGt(usdc.balanceOf(address(this)),beforeFee);assertEq(pm.getPositionLiquidity(id),2e13);
        uint256 beforeAgain=usdc.balanceOf(address(this));_remove(pm,id,0,0,0);assertEq(usdc.balanceOf(address(this)),beforeAgain);
        hook.setPaused(true);
        uint256 beforeCity=city.balanceOf(address(this));uint256 beforeUsdc=usdc.balanceOf(address(this));
        _remove(pm,id,2e13,1,1);
        assertEq(pm.getPositionLiquidity(id),0);assertEq(pm.ownerOf(id),address(this));
        assertGt(city.balanceOf(address(this)),beforeCity);assertGt(usdc.balanceOf(address(this)),beforeUsdc);
    }
    function testPositionOwnerMinimumOutputsAndDeadlineAreOnchain() public {
        PositionManager pm=_positionManager();uint256 id=_mint(pm);
        bytes[] memory params=new bytes[](2);
        params[0]=abi.encode(id,uint256(1e13),uint128(0),uint128(0),bytes(""));
        params[1]=abi.encode(address(city),address(usdc),trader);
        vm.expectRevert();vm.prank(trader);pm.modifyLiquidities(abi.encode(hex"0111",params),vm.getBlockTimestamp()+120);
        assertEq(pm.getPositionLiquidity(id),1e13);
        vm.expectRevert();_remove(pm,id,1e13,type(uint128).max,type(uint128).max);
        assertEq(pm.getPositionLiquidity(id),1e13);
        vm.expectRevert();pm.modifyLiquidities(abi.encode(hex"0111",params),vm.getBlockTimestamp()-1);
    }
    function testSandwichFrontLegBeyondImpactLimitCannotMovePoolOrSpend() public {
        liquidity.modifyLiquidity(key,ModifyLiquidityParams(lower,upper,-int256(uint256(SEED-FLOOR)),0),"");
        vm.warp(vm.getBlockTimestamp()+300);vm.roll(vm.getBlockNumber()+1);hook.checkpoint();
        health.publish(health.sequence()+1,true,uint64(vm.getBlockTimestamp()+300));
        uint256 beforeCity=city.balanceOf(trader);uint256 beforeUsdc=usdc.balanceOf(trader);
        vm.expectRevert();vm.prank(trader);router.swap(false,5e18,10e6);
        assertEq(city.balanceOf(trader),beforeCity);assertEq(usdc.balanceOf(trader),beforeUsdc);
        // Bounded smaller sandwiches can still fit: these guards are not complete MEV protection.
    }
}
