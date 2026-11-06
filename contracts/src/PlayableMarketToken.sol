// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.26;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC20Capped} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Capped.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";

/// Dedicated test asset. No promise of Game Coin, Minecraft item or cash backing.
contract PlayableMarketToken is ERC20Capped, AccessControl {
    bytes32 public constant ISSUER_ROLE = keccak256("ISSUER_ROLE");

    constructor(string memory name_, string memory symbol_, address administrator, address issuer, uint256 cap_)
        ERC20(name_, symbol_) ERC20Capped(cap_)
    {
        require(administrator != address(0) && issuer != address(0) && administrator != issuer, "distinct roles");
        require(keccak256(bytes(symbol_)) == keccak256("CITY") || keccak256(bytes(symbol_)) == keccak256("GEM"), "test assets only");
        _grantRole(DEFAULT_ADMIN_ROLE, administrator);
        _grantRole(ISSUER_ROLE, issuer);
    }

    function mint(address recipient, uint256 amount) external onlyRole(ISSUER_ROLE) {
        _mint(recipient, amount);
    }
}
