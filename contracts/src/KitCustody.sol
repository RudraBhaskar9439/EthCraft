// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.26;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// Synthetic local custody: the issuer attests stock; no Minecraft inventory is connected.
contract KitCustody is ERC20 {
    uint256 public constant UNIT = 1e18;
    address public immutable issuer;
    address public immutable warehouse;
    bytes32 public immutable serverId;
    bytes32 public immutable bundleHash;
    uint256[6] public bill;
    uint256[6] public controlledStock;
    uint256 public pendingKits;
    uint256 public nextClaim;
    mapping(bytes32 => bool) public usedDeposits;
    mapping(bytes32 => bool) public usedDeliveryReceipts;

    struct Claim {
        bytes32 jobId;
        address recipient;
        bytes32 destinationHash;
        uint256 kits;
        bool delivered;
    }
    mapping(bytes32 => Claim) public claims;

    event Deposited(bytes32 indexed depositId, bytes32 indexed domainKey, address indexed recipient, uint256 kits);
    event ClaimCreated(bytes32 indexed claimId, bytes32 indexed jobId, address indexed recipient, uint256 kits, bytes32 destinationHash);
    event Delivered(bytes32 indexed claimId, bytes32 indexed deliveryReceipt, uint256 kits);

    constructor(address issuer_, address warehouse_, bytes32 serverId_, bytes32 bundleHash_, uint256[6] memory bill_)
        ERC20("AgentCity local material claim", "KIT")
    {
        require(issuer_ != address(0) && warehouse_ != address(0), "roles");
        require(serverId_ != bytes32(0) && bundleHash_ != bytes32(0), "domain");
        issuer = issuer_;
        warehouse = warehouse_;
        serverId = serverId_;
        bundleHash = bundleHash_;
        for (uint256 item; item < 6; item++) require(bill_[item] > 0, "bill");
        bill = bill_;
    }

    function depositAndIssue(bytes32 depositId, address recipient, uint256 kits, uint256[6] calldata observedItems) external {
        require(msg.sender == issuer, "issuer");
        require(depositId != bytes32(0) && !usedDeposits[depositId], "deposit replay");
        require(recipient != address(0) && kits > 0, "quantity or recipient");
        for (uint256 item; item < 6; item++) {
            require(observedItems[item] == bill[item] * kits, "incomplete bundle");
            controlledStock[item] += observedItems[item];
        }
        usedDeposits[depositId] = true;
        _mint(recipient, kits * UNIT);
        require(backed(), "backing");
        bytes32 key = keccak256(abi.encode(block.chainid, address(this), serverId, bundleHash, depositId));
        emit Deposited(depositId, key, recipient, kits);
    }

    function redeem(uint256 kits, bytes32 jobId, address recipient, bytes32 destinationHash) external returns (bytes32 claimId) {
        require(kits > 0 && jobId != bytes32(0) && recipient != address(0) && destinationHash != bytes32(0), "claim terms");
        _burn(msg.sender, kits * UNIT);
        pendingKits += kits;
        claimId = keccak256(abi.encode(block.chainid, address(this), serverId, bundleHash, ++nextClaim));
        claims[claimId] = Claim(jobId, recipient, destinationHash, kits, false);
        require(backed(), "backing");
        emit ClaimCreated(claimId, jobId, recipient, kits, destinationHash);
    }

    function markDelivered(bytes32 claimId, bytes32 deliveryReceipt) external {
        require(msg.sender == warehouse, "warehouse");
        Claim storage claim = claims[claimId];
        require(claim.kits > 0 && !claim.delivered, "claim replay");
        require(deliveryReceipt != bytes32(0) && !usedDeliveryReceipts[deliveryReceipt], "receipt replay");
        claim.delivered = true;
        usedDeliveryReceipts[deliveryReceipt] = true;
        pendingKits -= claim.kits;
        for (uint256 item; item < 6; item++) controlledStock[item] -= bill[item] * claim.kits;
        require(backed(), "backing");
        emit Delivered(claimId, deliveryReceipt, claim.kits);
    }

    function backed() public view returns (bool) {
        uint256 liabilities = totalSupply() + pendingKits * UNIT;
        for (uint256 item; item < 6; item++) {
            uint256 required = (liabilities * bill[item] + UNIT - 1) / UNIT;
            if (controlledStock[item] < required) return false;
        }
        return true;
    }
}
