// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

contract JobEscrow is EIP712, ReentrancyGuard {
    using SafeERC20 for IERC20;
    IERC20 public immutable cred;
    address public immutable kit;
    address public immutable attestor;
    bytes32 public constant AGREEMENT_TYPEHASH = keccak256("Agreement(bytes32 jobId,bytes32 serverId,uint256 version,address requester,address builder,address cred,address kit,bytes32 bundleHash,bytes32 blueprintHash,bytes32 testsHash,bytes32 accessHash,bytes32 scopeHash,uint256 materialCap,bytes32 allocationsHash,uint64 workDeadline,uint64 reviewDeadline,uint64 passDeadline,uint64 absoluteExpiry)");
    bytes32 public constant INSPECTION_TYPEHASH = keccak256("Inspection(bytes32 jobId,bytes32 agreementHash,bytes32 blueprintHash,bytes32 testsHash,bytes32 reportHash,bytes32 lockHash,uint64 revision,uint64 completedAt,uint64 validUntil,bool passed,uint16 casesPassed,uint16 casesTotal)");

    struct Agreement {
        bytes32 jobId;
        bytes32 serverId;
        uint256 version;
        address requester;
        address builder;
        address cred;
        address kit;
        bytes32 bundleHash;
        bytes32 blueprintHash;
        bytes32 testsHash;
        bytes32 accessHash;
        bytes32 scopeHash;
        uint256 materialCap;
        bytes32 allocationsHash;
        uint64 workDeadline;
        uint64 reviewDeadline;
        uint64 passDeadline;
        uint64 absoluteExpiry;
    }

    struct Inspection {
        bytes32 jobId;
        bytes32 agreementHash;
        bytes32 blueprintHash;
        bytes32 testsHash;
        bytes32 reportHash;
        bytes32 lockHash;
        uint64 revision;
        uint64 completedAt;
        uint64 validUntil;
        bool passed;
        uint16 casesPassed;
        uint16 casesTotal;
    }

    struct Job {
        Agreement terms;
        bytes32 agreementHash;
        uint256 total;
        bool accepted;
        bool refunded;
    }
    mapping(bytes32 => Job) private jobs;
    mapping(bytes32 => mapping(address => uint256)) public allocations;
    mapping(bytes32 => bool) public invalidReports;

    event Funded(bytes32 indexed jobId, bytes32 indexed agreementHash, address indexed requester, uint256 total);
    event Accepted(bytes32 indexed jobId, bytes32 indexed reportHash, uint64 revision);
    event Claimed(bytes32 indexed jobId, address indexed recipient, uint256 amount);
    event Refunded(bytes32 indexed jobId, address indexed requester, uint256 amount);
    event ReportInvalidated(bytes32 indexed reportDigest);

    constructor(IERC20 cred_, address kit_, address attestor_) EIP712("AgentCityEscrow", "1") {
        require(address(cred_).code.length > 0 && kit_.code.length > 0 && attestor_ != address(0), "escrow roles");
        cred = cred_;
        kit = kit_;
        attestor = attestor_;
    }

    function hashAgreement(Agreement calldata terms) public view returns (bytes32) {
        return _hashTypedDataV4(keccak256(abi.encode(AGREEMENT_TYPEHASH, terms)));
    }

    function hashInspection(Inspection calldata report) public view returns (bytes32) {
        return _hashTypedDataV4(keccak256(abi.encode(INSPECTION_TYPEHASH, report)));
    }

    function fund(Agreement calldata terms, address[] calldata recipients, uint256[] calldata amounts,
        bytes calldata requesterSignature, bytes calldata builderSignature) external nonReentrant
    {
        require(terms.jobId != bytes32(0) && jobs[terms.jobId].agreementHash == bytes32(0), "job replay");
        require(msg.sender == terms.requester && terms.requester != terms.builder && terms.builder != address(0), "parties");
        require(terms.cred == address(cred) && terms.kit == kit, "assets");
        require(terms.version > 0 && terms.serverId != bytes32(0) && terms.bundleHash != bytes32(0) &&
            terms.blueprintHash != bytes32(0) && terms.testsHash != bytes32(0) &&
            terms.accessHash != bytes32(0) && terms.scopeHash != bytes32(0), "agreement context");
        require(block.timestamp < terms.workDeadline && terms.workDeadline < terms.passDeadline &&
            terms.passDeadline <= terms.reviewDeadline && terms.reviewDeadline == terms.absoluteExpiry, "deadlines");
        require(recipients.length > 0 && recipients.length <= 8 && recipients.length == amounts.length, "allocations");
        require(keccak256(abi.encode(recipients, amounts)) == terms.allocationsHash, "allocation hash");
        bytes32 digest = hashAgreement(terms);
        require(ECDSA.recover(digest, requesterSignature) == terms.requester &&
            ECDSA.recover(digest, builderSignature) == terms.builder, "approvals");
        uint256 total;
        for (uint256 index; index < recipients.length; index++) {
            require(recipients[index] != address(0) && amounts[index] > 0, "allocation value");
            require(allocations[terms.jobId][recipients[index]] == 0, "duplicate recipient");
            allocations[terms.jobId][recipients[index]] = amounts[index];
            total += amounts[index];
        }
        jobs[terms.jobId] = Job(terms, digest, total, false, false);
        uint256 beforeBalance = cred.balanceOf(address(this));
        cred.safeTransferFrom(msg.sender, address(this), total);
        require(cred.balanceOf(address(this)) == beforeBalance + total, "exact funding");
        emit Funded(terms.jobId, digest, msg.sender, total);
    }

    function accept(bytes32 jobId, Inspection calldata report, bytes calldata attestorSignature) external {
        Job storage job = jobs[jobId];
        require(msg.sender == job.terms.requester && job.agreementHash != bytes32(0), "requester");
        require(!job.accepted && !job.refunded, "finalized");
        require(block.timestamp < job.terms.reviewDeadline && block.timestamp < job.terms.absoluteExpiry, "acceptance expired");
        require(report.jobId == jobId && report.agreementHash == job.agreementHash &&
            report.blueprintHash == job.terms.blueprintHash && report.testsHash == job.terms.testsHash, "report binding");
        require(report.reportHash != bytes32(0) && report.lockHash != bytes32(0) && report.passed &&
            report.casesPassed == 16 && report.casesTotal == 16, "passing inspection");
        require(report.completedAt <= block.timestamp && report.completedAt < job.terms.workDeadline &&
            block.timestamp < report.validUntil && report.validUntil <= job.terms.passDeadline, "report expiry");
        bytes32 digest = hashInspection(report);
        require(!invalidReports[digest] && ECDSA.recover(digest, attestorSignature) == attestor, "attestation");
        job.accepted = true;
        emit Accepted(jobId, report.reportHash, report.revision);
    }

    function invalidateReport(bytes32 reportDigest) external {
        require(msg.sender == attestor && reportDigest != bytes32(0), "attestor");
        invalidReports[reportDigest] = true;
        emit ReportInvalidated(reportDigest);
    }

    function claim(bytes32 jobId) external nonReentrant {
        Job storage job = jobs[jobId];
        require(job.accepted, "not accepted");
        uint256 amount = allocations[jobId][msg.sender];
        require(amount > 0, "claim replay");
        allocations[jobId][msg.sender] = 0;
        cred.safeTransfer(msg.sender, amount);
        emit Claimed(jobId, msg.sender, amount);
    }

    function refund(bytes32 jobId) external nonReentrant {
        Job storage job = jobs[jobId];
        require(msg.sender == job.terms.requester && job.agreementHash != bytes32(0), "requester");
        require(!job.accepted && !job.refunded && block.timestamp >= job.terms.absoluteExpiry, "refund unavailable");
        job.refunded = true;
        cred.safeTransfer(msg.sender, job.total);
        emit Refunded(jobId, msg.sender, job.total);
    }

    function status(bytes32 jobId) external view returns (bytes32 agreementHash, uint256 total, bool accepted, bool refunded) {
        Job storage job = jobs[jobId];
        return (job.agreementHash, job.total, job.accepted, job.refunded);
    }
}
