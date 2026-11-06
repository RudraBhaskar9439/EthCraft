// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.26;

contract StateRegistry {
    address public immutable publisher;
    bytes32 public immutable marketId;
    uint64 public constant MAX_TTL = 300;
    uint64 public sequence;
    uint64 public validUntil;
    bool public healthy;
    event StatePublished(bytes32 indexed marketId, uint64 sequence, bool healthy, uint64 validUntil);

    constructor(address publisher_, bytes32 marketId_) {
        require(publisher_ != address(0) && marketId_ != bytes32(0), "registry terms");
        publisher = publisher_;
        marketId = marketId_;
    }

    function publish(uint64 sequence_, bool healthy_, uint64 validUntil_) external {
        require(msg.sender == publisher, "publisher");
        require(sequence_ > sequence, "sequence");
        require(validUntil_ > block.timestamp && validUntil_ <= block.timestamp + MAX_TTL, "freshness");
        sequence = sequence_;
        healthy = healthy_;
        validUntil = validUntil_;
        emit StatePublished(marketId, sequence_, healthy_, validUntil_);
    }

    function available() external view returns (bool) {
        return healthy && block.timestamp < validUntil;
    }
}
