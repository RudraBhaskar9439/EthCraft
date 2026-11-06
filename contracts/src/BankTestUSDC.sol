// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.26;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC20Capped} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Capped.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";

/// Faucet-only mock. This token is not issued by Circle and has no USD backing.
contract BankTestUSDC is ERC20Capped, AccessControl {
    bytes32 public constant ISSUER_ROLE = keccak256("ISSUER_ROLE");

    constructor(address administrator, address issuer) ERC20("AgentCity Mock USDC", "tUSDC") ERC20Capped(1_000_000e6) {
        require(block.chainid == 31337 || block.chainid == 1301, "testnet only");
        require(administrator != address(0) && issuer != address(0) && administrator != issuer, "distinct roles");
        _grantRole(DEFAULT_ADMIN_ROLE, administrator);
        _grantRole(ISSUER_ROLE, issuer);
    }

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address recipient, uint256 amount) external onlyRole(ISSUER_ROLE) {
        _mint(recipient, amount);
    }
}
