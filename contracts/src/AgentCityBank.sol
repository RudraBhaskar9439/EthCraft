// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.26;

import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IERC721Receiver} from "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {WorldAssetRegistry} from "./WorldAssetRegistry.sol";

/// Testnet-only, lender-funded fixed-term loans. Lender valuations are agreed
/// reference prices, not market oracles; collateral still trusts native custody.
contract AgentCityBank is IERC721Receiver, ReentrancyGuard {
    using SafeERC20 for IERC20Metadata;

    uint256 public constant MAX_PRINCIPAL = 30e6;
    uint256 public constant MAX_LTV_BPS = 3000;
    uint256 public constant MAX_FEE_BPS = 100;
    uint256 public constant MIN_TERM = 60;
    uint256 public constant MAX_TERM = 30 days;
    uint256 public constant MIN_GRACE = 60;
    uint256 public constant MAX_GRACE = 7 days;
    uint256 public constant MIN_AUCTION = 60;
    uint256 public constant MAX_AUCTION = 7 days;
    uint256 public constant MAX_OFFER_LIFETIME = 1 days;
    uint256 public constant MIN_REPUTATION_PRINCIPAL = 1e6;
    uint256 public constant MIN_REPUTATION_AGE = 60;

    enum State {
        None,
        Offered,
        Active,
        Auction,
        Repaid,
        Liquidated,
        Cancelled
    }

    struct LoanTerms {
        address borrower;
        uint256 tokenId;
        uint64 ownershipNonce;
        uint64 revision;
        bytes32 snapshotHash;
        uint128 valuation;
        uint128 principal;
        uint128 repayment;
        uint48 term;
        uint48 grace;
        uint48 offerExpiry;
        uint48 auctionDuration;
        uint128 auctionReserve;
    }

    struct Loan {
        LoanTerms terms;
        bytes32 termsHash;
        State state;
        uint48 takenAt;
        uint48 dueAt;
        uint48 auctionEnd;
        uint128 highestBid;
        address highestBidder;
        address collateralClaimant;
        bool defaultRecorded;
    }

    struct History {
        uint256 principalBorrowed;
        uint256 principalRepaid;
        uint256 timelyPrincipalRepaid;
        uint256 timelyLoansRepaid;
        uint256 defaults;
        uint256 badDebt;
        uint256 activePrincipal;
    }

    WorldAssetRegistry public immutable registry;
    IERC20Metadata public immutable usdc;
    address public immutable lender;
    mapping(bytes32 => Loan) private _loans;
    mapping(address => bytes32) public activeLoan;
    mapping(uint256 => bytes32) public collateralLoan;
    mapping(address => History) public history;
    mapping(address => uint256) public credits;
    uint256 public totalOfferReserves;
    uint256 public totalBidEscrow;
    uint256 public totalCredits;
    bytes32 private _receivingLoan;

    event LoanOffered(
        bytes32 indexed loanId,
        address indexed borrower,
        uint256 indexed tokenId,
        bytes32 termsHash,
        uint128 principal,
        uint128 repayment,
        uint48 offerExpiry
    );
    event LoanTaken(
        bytes32 indexed loanId, address indexed borrower, uint256 indexed tokenId, uint128 principal, uint48 dueAt
    );
    event OfferCancelled(bytes32 indexed loanId);
    event LoanRepaid(bytes32 indexed loanId, address indexed borrower, uint128 repayment, bool timely);
    event LoanDefaulted(bytes32 indexed loanId, address indexed borrower);
    event AuctionStarted(bytes32 indexed loanId, uint48 auctionEnd);
    event BidPlaced(bytes32 indexed loanId, address indexed bidder, uint128 amount);
    event AuctionSettled(
        bytes32 indexed loanId, address indexed buyer, uint256 proceeds, uint256 surplus, uint256 badDebt
    );
    event CollateralClaimed(
        bytes32 indexed loanId, address indexed claimant, address indexed recipient, uint256 tokenId
    );
    event CreditWithdrawn(address indexed owner, address indexed recipient, uint256 amount);

    constructor(WorldAssetRegistry registry_, IERC20Metadata usdc_, address lender_) {
        require(block.chainid == 31337 || block.chainid == 1301, "testnet only");
        require(
            address(registry_).code.length > 0 && address(usdc_).code.length > 0 && lender_ != address(0),
            "deployed bank terms"
        );
        require(usdc_.decimals() == 6, "six decimal test USDC");
        registry = registry_;
        usdc = usdc_;
        lender = lender_;
    }

    function loan(bytes32 loanId) external view returns (Loan memory) {
        return _loans[loanId];
    }

    function termsHash(bytes32 loanId) external view returns (bytes32) {
        return _loans[loanId].termsHash;
    }

    function _checkCollateral(LoanTerms memory terms) private view {
        WorldAssetRegistry.Asset memory asset = registry.asset(terms.tokenId);
        require(
            asset.kind == WorldAssetRegistry.Kind.Item && registry.ownerOf(terms.tokenId) == terms.borrower
                && registry.isTransferable(terms.tokenId) && collateralLoan[terms.tokenId] == 0,
            "available item required"
        );
        require(
            asset.ownershipNonce == terms.ownershipNonce && asset.revision == terms.revision
                && asset.snapshotHash == terms.snapshotHash,
            "collateral terms changed"
        );
    }

    function _receive(address from, uint256 amount) private {
        uint256 beforeBalance = usdc.balanceOf(address(this));
        usdc.safeTransferFrom(from, address(this), amount);
        require(usdc.balanceOf(address(this)) == beforeBalance + amount, "exact USDC receipt");
    }

    function _pay(address to, uint256 amount) private {
        uint256 beforeBalance = usdc.balanceOf(address(this));
        uint256 beforeRecipient = usdc.balanceOf(to);
        usdc.safeTransfer(to, amount);
        require(
            usdc.balanceOf(address(this)) == beforeBalance - amount && usdc.balanceOf(to) == beforeRecipient + amount,
            "exact USDC payment"
        );
    }

    function _credit(address owner, uint256 amount) private {
        credits[owner] += amount;
        totalCredits += amount;
    }

    function offerLoan(bytes32 loanId, LoanTerms calldata terms) external nonReentrant {
        require(msg.sender == lender, "lender only");
        require(loanId != 0 && _loans[loanId].state == State.None, "loan ID used");
        require(
            terms.borrower != address(0) && terms.borrower != lender && terms.borrower != address(this),
            "borrower required"
        );
        require(
            terms.principal > 0 && terms.principal <= MAX_PRINCIPAL
                && uint256(terms.principal) * 10000 <= uint256(terms.valuation) * MAX_LTV_BPS,
            "principal LTV bounds"
        );
        require(
            terms.repayment >= terms.principal
                && uint256(terms.repayment) - terms.principal <= uint256(terms.principal) * MAX_FEE_BPS / 10000,
            "repayment bounds"
        );
        require(
            terms.term >= MIN_TERM && terms.term <= MAX_TERM && terms.grace >= MIN_GRACE && terms.grace <= MAX_GRACE,
            "term grace bounds"
        );
        require(
            terms.offerExpiry > block.timestamp && terms.offerExpiry <= block.timestamp + MAX_OFFER_LIFETIME,
            "offer expiry"
        );
        require(
            terms.auctionDuration >= MIN_AUCTION && terms.auctionDuration <= MAX_AUCTION && terms.auctionReserve > 0
                && terms.auctionReserve <= terms.valuation,
            "auction bounds"
        );
        _checkCollateral(terms);
        Loan storage value = _loans[loanId];
        value.terms = terms;
        value.termsHash = keccak256(abi.encode(block.chainid, address(this), lender, loanId, terms));
        value.state = State.Offered;
        totalOfferReserves += terms.principal;
        _receive(lender, terms.principal);
        emit LoanOffered(
            loanId, terms.borrower, terms.tokenId, value.termsHash, terms.principal, terms.repayment, terms.offerExpiry
        );
    }

    function cancelOffer(bytes32 loanId) external nonReentrant {
        Loan storage value = _loans[loanId];
        require(value.state == State.Offered, "offered loan required");
        require(
            msg.sender == lender || msg.sender == value.terms.borrower || block.timestamp >= value.terms.offerExpiry,
            "offer cancellation authority"
        );
        value.state = State.Cancelled;
        totalOfferReserves -= value.terms.principal;
        _credit(lender, value.terms.principal);
        emit OfferCancelled(loanId);
    }

    function takeLoan(bytes32 loanId, bytes32 expectedTermsHash) external nonReentrant {
        Loan storage value = _loans[loanId];
        LoanTerms memory terms = value.terms;
        require(value.state == State.Offered && block.timestamp < terms.offerExpiry, "live offered loan required");
        require(msg.sender == terms.borrower && expectedTermsHash == value.termsHash, "borrower exact consent");
        require(activeLoan[msg.sender] == 0, "borrower already active");
        _checkCollateral(terms);
        value.state = State.Active;
        value.takenAt = uint48(block.timestamp);
        value.dueAt = uint48(block.timestamp + terms.term);
        activeLoan[msg.sender] = loanId;
        collateralLoan[terms.tokenId] = loanId;
        totalOfferReserves -= terms.principal;
        History storage record = history[msg.sender];
        record.principalBorrowed += terms.principal;
        record.activePrincipal += terms.principal;
        _receivingLoan = loanId;
        registry.safeTransferFrom(msg.sender, address(this), terms.tokenId);
        _receivingLoan = 0;
        require(registry.ownerOf(terms.tokenId) == address(this), "collateral custody required");
        _pay(msg.sender, terms.principal);
        emit LoanTaken(loanId, msg.sender, terms.tokenId, terms.principal, value.dueAt);
    }

    function _default(bytes32 loanId, Loan storage value) private {
        if (!value.defaultRecorded) {
            value.defaultRecorded = true;
            history[value.terms.borrower].defaults++;
            emit LoanDefaulted(loanId, value.terms.borrower);
        }
    }

    function repay(bytes32 loanId) external nonReentrant {
        Loan storage value = _loans[loanId];
        require(msg.sender == value.terms.borrower, "borrower only");
        require(
            value.state == State.Active || value.state == State.Auction && block.timestamp < value.auctionEnd,
            "repayable loan required"
        );
        if (block.timestamp > uint256(value.dueAt) + value.terms.grace) _default(loanId, value);
        bool timely = block.timestamp <= value.dueAt && block.timestamp >= uint256(value.takenAt) + MIN_REPUTATION_AGE
            && value.terms.principal >= MIN_REPUTATION_PRINCIPAL;
        value.state = State.Repaid;
        value.collateralClaimant = msg.sender;
        activeLoan[msg.sender] = 0;
        History storage record = history[msg.sender];
        record.activePrincipal -= value.terms.principal;
        record.principalRepaid += value.terms.principal;
        if (timely) {
            record.timelyPrincipalRepaid += value.terms.principal;
            record.timelyLoansRepaid++;
        }
        if (value.highestBid > 0) {
            totalBidEscrow -= value.highestBid;
            _credit(value.highestBidder, value.highestBid);
            value.highestBid = 0;
            value.highestBidder = address(0);
        }
        _receive(msg.sender, value.terms.repayment);
        _credit(lender, value.terms.repayment);
        emit LoanRepaid(loanId, msg.sender, value.terms.repayment, timely);
    }

    function startAuction(bytes32 loanId) external nonReentrant {
        Loan storage value = _loans[loanId];
        require(
            value.state == State.Active && block.timestamp > uint256(value.dueAt) + value.terms.grace,
            "overdue loan required"
        );
        value.state = State.Auction;
        value.auctionEnd = uint48(block.timestamp + value.terms.auctionDuration);
        _default(loanId, value);
        emit AuctionStarted(loanId, value.auctionEnd);
    }

    function bid(bytes32 loanId, uint128 amount) external nonReentrant {
        Loan storage value = _loans[loanId];
        require(value.state == State.Auction && block.timestamp < value.auctionEnd, "live auction required");
        require(
            msg.sender != value.terms.borrower && amount >= value.terms.auctionReserve && amount > value.highestBid,
            "higher funded bid required"
        );
        if (value.highestBid > 0) {
            totalBidEscrow -= value.highestBid;
            _credit(value.highestBidder, value.highestBid);
        }
        value.highestBid = amount;
        value.highestBidder = msg.sender;
        totalBidEscrow += amount;
        _receive(msg.sender, amount);
        emit BidPlaced(loanId, msg.sender, amount);
    }

    function settleAuction(bytes32 loanId) external nonReentrant {
        Loan storage value = _loans[loanId];
        require(value.state == State.Auction && block.timestamp >= value.auctionEnd, "ended auction required");
        value.state = State.Liquidated;
        activeLoan[value.terms.borrower] = 0;
        uint256 proceeds = value.highestBid;
        uint256 recovered = proceeds < value.terms.repayment ? proceeds : value.terms.repayment;
        uint256 surplus = proceeds - recovered;
        uint256 badDebt = uint256(value.terms.repayment) - recovered;
        totalBidEscrow -= proceeds;
        value.collateralClaimant = value.highestBidder == address(0) ? lender : value.highestBidder;
        _credit(lender, recovered);
        _credit(value.terms.borrower, surplus);
        History storage record = history[value.terms.borrower];
        record.activePrincipal -= value.terms.principal;
        record.badDebt += badDebt;
        emit AuctionSettled(loanId, value.collateralClaimant, proceeds, surplus, badDebt);
    }

    function claimCollateral(bytes32 loanId, address recipient) external nonReentrant {
        Loan storage value = _loans[loanId];
        require(
            value.collateralClaimant == msg.sender && recipient != address(0) && recipient != address(this),
            "collateral claimant required"
        );
        value.collateralClaimant = address(0);
        collateralLoan[value.terms.tokenId] = 0;
        registry.safeTransferFrom(address(this), recipient, value.terms.tokenId);
        emit CollateralClaimed(loanId, msg.sender, recipient, value.terms.tokenId);
    }

    function withdraw(address recipient) external nonReentrant {
        uint256 amount = credits[msg.sender];
        require(amount > 0 && recipient != address(0) && recipient != address(this), "withdrawal credit required");
        credits[msg.sender] = 0;
        totalCredits -= amount;
        _pay(recipient, amount);
        emit CreditWithdrawn(msg.sender, recipient, amount);
    }

    function onERC721Received(address operator, address from, uint256 tokenId, bytes calldata)
        external
        view
        returns (bytes4)
    {
        Loan storage value = _loans[_receivingLoan];
        require(
            msg.sender == address(registry) && _receivingLoan != 0 && operator == address(this)
                && value.state == State.Active && from == value.terms.borrower && tokenId == value.terms.tokenId,
            "expected collateral only"
        );
        return IERC721Receiver.onERC721Received.selector;
    }
}
