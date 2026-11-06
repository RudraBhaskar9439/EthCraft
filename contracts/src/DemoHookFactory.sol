// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.26;

/// Deployment helper for the isolated public-testnet contract demonstration.
contract DemoHookFactory {
    address public immutable deployer = msg.sender;

    function deploy(bytes32 salt, bytes memory code) external returns (address deployed) {
        require(msg.sender == deployer, "deployer only");
        assembly { deployed := create2(0, add(code, 32), mload(code), salt) }
        require(deployed != address(0), "hook deployment failed");
    }
}
