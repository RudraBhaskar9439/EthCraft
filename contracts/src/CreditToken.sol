// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.26;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/// Controlled demonstration currency. Local minting is not economic demand or cash backing.
contract CreditToken is ERC20, Ownable {
    address public immutable issuer;

    constructor(address administrator, address issuer_) ERC20("AgentCity local credit", "CRED") Ownable(administrator) {
        require(issuer_ != address(0) && issuer_ != administrator, "separate issuer");
        issuer = issuer_;
    }

    function mint(address recipient, uint256 amount) external {
        require(msg.sender == issuer, "issuer");
        _mint(recipient, amount);
    }

    function transferOwnership(address newOwner) public override onlyOwner {
        require(newOwner != issuer, "separate issuer");
        super.transferOwnership(newOwner);
    }
}
