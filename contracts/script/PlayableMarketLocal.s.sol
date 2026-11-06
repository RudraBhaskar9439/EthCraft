// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.26;

import {Script} from "forge-std/Script.sol";
import {PoolManager} from "@uniswap/v4-core/src/PoolManager.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {ModifyLiquidityParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {PoolModifyLiquidityTest} from "@uniswap/v4-core/src/test/PoolModifyLiquidityTest.sol";
import {V4Quoter} from "@uniswap/v4-periphery/src/lens/V4Quoter.sol";
import {PlayableMarketToken} from "../src/PlayableMarketToken.sol";
import {PlayableMarketRouter} from "../src/PlayableMarketRouter.sol";

/// Dedicated Anvil setup only. Public setup must use separate funded role wallets
/// and official PositionManager liquidity; this LP test helper is not published.
contract PlayableMarketLocal is Script {
    function run() external {
        require(block.chainid == 31337, "local fixture only");
        address administrator=vm.envAddress("PLAYABLE_MARKET_ADMIN");
        address issuer=vm.envAddress("PLAYABLE_MARKET_ISSUER");
        require(administrator != issuer && issuer != address(0), "distinct local roles");
        vm.startBroadcast(administrator);
        PlayableMarketToken city=new PlayableMarketToken("AgentCity Test CITY","CITY",administrator,issuer,1_000_000e18);
        PlayableMarketToken gem=new PlayableMarketToken("AgentCity Test GEM","GEM",administrator,issuer,1_000_000e18);
        PoolManager manager=new PoolManager(administrator);
        PoolKey memory key=PoolKey({currency0:Currency.wrap(address(city)<address(gem)?address(city):address(gem)),
            currency1:Currency.wrap(address(city)<address(gem)?address(gem):address(city)),fee:3000,tickSpacing:60,hooks:IHooks(address(0))});
        manager.initialize(key,uint160(1<<96));
        V4Quoter quoter=new V4Quoter(IPoolManager(address(manager)));
        PlayableMarketRouter router=new PlayableMarketRouter(IPoolManager(address(manager)),key);
        PoolModifyLiquidityTest liquidity=new PoolModifyLiquidityTest(IPoolManager(address(manager)));
        vm.stopBroadcast();
        vm.startBroadcast(issuer);
        city.mint(administrator,100_000e18); gem.mint(administrator,100_000e18);
        vm.stopBroadcast();
        vm.startBroadcast(administrator);
        city.approve(address(liquidity),100_000e18); gem.approve(address(liquidity),100_000e18);
        liquidity.modifyLiquidity(key,ModifyLiquidityParams(-600,600,10_000e18,bytes32(0)),"");
        vm.stopBroadcast();
        string memory object="playable-market";
        vm.serializeAddress(object,"administrator",administrator);vm.serializeAddress(object,"issuer",issuer);
        vm.serializeAddress(object,"CITY",address(city));vm.serializeAddress(object,"GEM",address(gem));
        vm.serializeAddress(object,"poolManager",address(manager));vm.serializeAddress(object,"quoter",address(quoter));
        vm.serializeAddress(object,"router",address(router));vm.serializeAddress(object,"currency0",Currency.unwrap(key.currency0));
        vm.serializeAddress(object,"currency1",Currency.unwrap(key.currency1));
        string memory encoded=vm.serializeAddress(object,"localLiquidityFixture",address(liquidity));
        vm.writeJson(encoded,vm.envString("PLAYABLE_MARKET_OUTPUT"));
    }
}
