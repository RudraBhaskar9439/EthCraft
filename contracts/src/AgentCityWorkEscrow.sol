// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// A funded quote pays only after native inspection and requester acceptance.
/// The inspector is trusted to check the actual game result, not an LLM claim.
contract AgentCityWorkEscrow is ReentrancyGuard {
    using SafeERC20 for IERC20;
    enum State {
        None,
        Funded,
        Running,
        Completed,
        Accepted,
        Refunded
    }

    struct Work {
        address requester;
        address worker;
        bytes32 termsHash;
        uint128 amount;
        uint48 deadline;
        uint32 reviewPeriod;
        State state;
        bytes32 resultHash;
    }
    IERC20 public immutable city;
    address public immutable inspector;
    mapping(bytes32 => Work) private works;

    event WorkFunded(
        bytes32 indexed workId,
        address indexed requester,
        address indexed worker,
        bytes32 termsHash,
        uint128 amount,
        uint48 deadline,
        uint32 reviewPeriod
    );
    event WorkStarted(bytes32 indexed workId, bytes32 termsHash);
    event WorkCompleted(bytes32 indexed workId, bytes32 termsHash, bytes32 resultHash);
    event WorkAccepted(bytes32 indexed workId, address indexed worker, bytes32 resultHash, uint128 amount);
    event WorkRefunded(bytes32 indexed workId, address indexed requester, uint128 amount);

    constructor(IERC20 city_, address inspector_) {
        require(block.chainid == 31337 || block.chainid == 1301, "testnet only");
        require(address(city_).code.length > 0 && inspector_ != address(0), "deployed token and inspector required");
        city = city_;
        inspector = inspector_;
    }

    function work(bytes32 workId) external view returns (Work memory) {
        return works[workId];
    }

    function fundWork(
        bytes32 workId,
        address worker,
        bytes32 termsHash,
        uint128 amount,
        uint48 workDeadline,
        uint32 reviewPeriod
    ) external nonReentrant {
        require(workId != 0 && works[workId].state == State.None, "work already exists");
        require(
            worker != address(0) && worker != msg.sender && termsHash != 0 && amount > 0 && amount <= 100e18,
            "bounded distinct work terms"
        );
        require(
            workDeadline > block.timestamp && workDeadline <= block.timestamp + 7 days && reviewPeriod >= 60
                && reviewPeriod <= 7 days,
            "bounded work deadline"
        );
        uint256 beforeBalance = city.balanceOf(address(this));
        works[workId] = Work(msg.sender, worker, termsHash, amount, workDeadline, reviewPeriod, State.Funded, 0);
        city.safeTransferFrom(msg.sender, address(this), amount);
        require(city.balanceOf(address(this)) == beforeBalance + amount, "exact work funding");
        emit WorkFunded(workId, msg.sender, worker, termsHash, amount, workDeadline, reviewPeriod);
    }

    function startWork(bytes32 workId, bytes32 termsHash) external {
        Work storage value = works[workId];
        require(
            msg.sender == inspector && value.state == State.Funded && value.termsHash == termsHash
                && block.timestamp < value.deadline,
            "funded native start required"
        );
        value.state = State.Running;
        emit WorkStarted(workId, termsHash);
    }

    function recordCompletion(bytes32 workId, bytes32 termsHash, bytes32 resultHash) external {
        Work storage value = works[workId];
        require(
            msg.sender == inspector && value.state == State.Running && value.termsHash == termsHash && resultHash != 0
                && block.timestamp < value.deadline,
            "timely native result required"
        );
        value.resultHash = resultHash;
        value.state = State.Completed;
        emit WorkCompleted(workId, termsHash, resultHash);
    }

    function acceptWork(bytes32 workId, bytes32 termsHash, bytes32 resultHash) external nonReentrant {
        Work storage value = works[workId];
        require(
            msg.sender == value.requester && value.state == State.Completed && value.termsHash == termsHash
                && value.resultHash == resultHash && block.timestamp < uint256(value.deadline) + value.reviewPeriod,
            "requester accepts current result"
        );
        value.state = State.Accepted;
        _pay(value.worker, value.amount);
        emit WorkAccepted(workId, value.worker, resultHash, value.amount);
    }

    function refundWork(bytes32 workId) external nonReentrant {
        Work storage value = works[workId];
        require(
            msg.sender == value.requester
                && (value.state == State.Funded || value.state == State.Running || value.state == State.Completed),
            "refundable requester work required"
        );
        uint256 cutoff = uint256(value.deadline) + (value.state == State.Completed ? value.reviewPeriod : 0);
        require(block.timestamp >= cutoff, "work or review still valid");
        value.state = State.Refunded;
        _pay(value.requester, value.amount);
        emit WorkRefunded(workId, value.requester, value.amount);
    }

    function _pay(address recipient, uint256 amount) private {
        uint256 beforeBalance = city.balanceOf(recipient);
        city.safeTransfer(recipient, amount);
        require(city.balanceOf(recipient) == beforeBalance + amount, "exact work payment");
    }
}
