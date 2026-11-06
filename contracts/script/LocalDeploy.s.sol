// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.26;

import {Script} from "forge-std/Script.sol";
import {PoolManager} from "@uniswap/v4-core/src/PoolManager.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {ModifyLiquidityParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {PoolModifyLiquidityTest} from "@uniswap/v4-core/src/test/PoolModifyLiquidityTest.sol";
import {CreditToken} from "../src/CreditToken.sol";
import {KitCustody} from "../src/KitCustody.sol";
import {StateRegistry} from "../src/StateRegistry.sol";
import {AgentCityHook} from "../src/AgentCityHook.sol";
import {Procurement} from "../src/Procurement.sol";
import {JobEscrow} from "../src/JobEscrow.sol";

contract LocalHookFactory {
    function deploy(bytes32 salt, bytes memory code) external returns (address deployed) {
        assembly { deployed := create2(0, add(code, 32), mload(code), salt) }
        require(deployed != address(0), "hook deployment");
    }
}

/// Sends transactions only to an explicitly checked local development chain.
contract LocalDeploy is Script {
    function run() external {
        require(block.chainid == 31337, "local chain only");
        address admin = vm.envAddress("LOCAL_ADMIN");
        address warehouse = vm.envAddress("LOCAL_WAREHOUSE");
        address publisher = vm.envAddress("LOCAL_PUBLISHER");
        address attestor = vm.envAddress("LOCAL_ATTESTOR");
        address requester = vm.envAddress("LOCAL_REQUESTER");
        address builder = vm.envAddress("LOCAL_BUILDER");
        address issuer = vm.envAddress("LOCAL_ISSUER");
        address[7] memory roles = [admin, warehouse, publisher, attestor, requester, builder, issuer];
        for (uint256 left; left < roles.length; left++) {
            require(roles[left] != address(0), "role zero");
            for (uint256 right; right < left; right++) require(roles[left] != roles[right], "distinct roles");
        }
        vm.startBroadcast(admin);
        CreditToken cred = new CreditToken(admin, issuer);
        uint256[6] memory bill = [uint256(65), 4, 16, 37, 19, 3];
        KitCustody kit = new KitCustody(issuer, warehouse, keccak256("agentcity-local-server"), keccak256(abi.encode(bill)), bill);
        StateRegistry registry = new StateRegistry(publisher, keccak256("agentcity-local-cred-kit"));
        PoolManager manager = new PoolManager(admin);
        LocalHookFactory factory = new LocalHookFactory();
        bytes memory code = abi.encodePacked(type(AgentCityHook).creationCode, abi.encode(manager, registry, address(cred), address(kit)));
        bytes32 codeHash = keccak256(code);
        bytes32 salt;
        for (uint256 nonce; ; nonce++) {
            salt = bytes32(nonce);
            address predicted = address(uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), address(factory), salt, codeHash)))));
            if (uint160(predicted) & Hooks.ALL_HOOK_MASK == Hooks.BEFORE_SWAP_FLAG) break;
        }
        AgentCityHook hook = AgentCityHook(factory.deploy(salt, code));
        PoolKey memory key = PoolKey({
            currency0: Currency.wrap(address(cred) < address(kit) ? address(cred) : address(kit)),
            currency1: Currency.wrap(address(cred) < address(kit) ? address(kit) : address(cred)),
            fee: 3000,
            tickSpacing: 60,
            hooks: IHooks(address(hook))
        });
        manager.initialize(key, uint160(1 << 96));
        PoolModifyLiquidityTest liquidity = new PoolModifyLiquidityTest(manager);
        Procurement procurement = new Procurement(manager, cred, kit, key);
        JobEscrow escrow = new JobEscrow(cred, address(kit), attestor);
        vm.stopBroadcast();
        vm.startBroadcast(issuer);
        cred.mint(admin, 10000e18);
        cred.mint(requester, 1000e18);
        uint256[6] memory stock;
        for (uint256 item; item < 6; item++) stock[item] = bill[item] * 1000;
        kit.depositAndIssue(keccak256("local-seed-deposit"), admin, 1000, stock);
        vm.stopBroadcast();
        vm.startBroadcast(admin);
        cred.approve(address(liquidity), type(uint256).max);
        kit.approve(address(liquidity), type(uint256).max);
        liquidity.modifyLiquidity(key, ModifyLiquidityParams(-600, 600, 100e18, bytes32(0)), "");
        vm.stopBroadcast();
        vm.startBroadcast(publisher);
        registry.publish(1, true, uint64(block.timestamp + 300));
        vm.stopBroadcast();
        vm.startBroadcast(requester);
        cred.approve(address(procurement), type(uint256).max);
        cred.approve(address(escrow), type(uint256).max);
        vm.stopBroadcast();

        string memory object = "deployment";
        vm.serializeUint(object, "chainId", block.chainid);
        vm.serializeString(object, "environment", "LOCAL_SYNTHETIC_ONLY");
        vm.serializeAddress(object, "admin", admin);
        vm.serializeAddress(object, "warehouse", warehouse);
        vm.serializeAddress(object, "publisher", publisher);
        vm.serializeAddress(object, "attestor", attestor);
        vm.serializeAddress(object, "requester", requester);
        vm.serializeAddress(object, "builder", builder);
        vm.serializeAddress(object, "issuer", issuer);
        vm.serializeAddress(object, "creditToken", address(cred));
        vm.serializeAddress(object, "kitCustody", address(kit));
        vm.serializeAddress(object, "stateRegistry", address(registry));
        vm.serializeAddress(object, "poolManager", address(manager));
        vm.serializeAddress(object, "hook", address(hook));
        vm.serializeAddress(object, "procurement", address(procurement));
        vm.serializeAddress(object, "jobEscrow", address(escrow));
        vm.serializeAddress(object, "liquidityRouter", address(liquidity));
        vm.serializeBytes32(object, "serverId", kit.serverId());
        string memory result = vm.serializeBytes32(object, "bundleHash", kit.bundleHash());
        vm.writeJson(result, vm.envOr("LOCAL_DEPLOYMENT_OUTPUT", string("local-deployment.json")));
    }
}
