// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.26;
import {Test} from "forge-std/Test.sol";
import {DemoHookFactory} from "agentcity/DemoHookFactory.sol";

contract DemoTarget { function value() external pure returns (uint256) { return 1; } }

contract DemoHookFactoryTest is Test {
    function testDeploymentAndCallerBoundary() public {
        DemoHookFactory factory = new DemoHookFactory();
        bytes memory code = type(DemoTarget).creationCode;
        vm.prank(address(123));
        vm.expectRevert("deployer only");
        factory.deploy(bytes32(0), code);
        address deployed = factory.deploy(bytes32(0), code);
        assertEq(DemoTarget(deployed).value(), 1);
        vm.expectRevert("hook deployment failed");
        factory.deploy(bytes32(0), code);
    }
}
