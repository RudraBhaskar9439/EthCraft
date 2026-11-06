// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {IERC721Receiver} from "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";
import {WorldAssetRegistry} from "agentcity/WorldAssetRegistry.sol";
import {AgentCityBank} from "agentcity/AgentCityBank.sol";

contract BankUSDCFixture is ERC20 {
    constructor() ERC20("Disclosed test USDC fixture", "tUSDC") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

contract BankRejectingReceiverFixture is IERC721Receiver {
    function onERC721Received(address, address, uint256, bytes calldata) external pure returns (bytes4) {
        revert("fixture rejects item");
    }
}

/// Real isolated EVM accounting; native custody receipts and principals are
/// disclosed fixtures, not independent players or public lending qualification.
abstract contract AgentCityBankFixture is Test {
    address internal constant ADMIN = address(0xA11);
    address internal constant REGISTRAR = address(0xA22);
    address internal constant LENDER = address(0xA33);
    address internal constant BORROWER = address(0xA44);
    address internal constant BIDDER = address(0xA55);
    address internal constant OTHER = address(0xA66);
    WorldAssetRegistry internal registry;
    BankUSDCFixture internal usdc;
    AgentCityBank internal bank;
    uint256 internal receiptSequence;

    function setUp() public virtual {
        vm.chainId(31337);
        vm.warp(1000);
        registry = new WorldAssetRegistry(ADMIN, REGISTRAR);
        usdc = new BankUSDCFixture();
        bank = new AgentCityBank(registry, IERC20Metadata(address(usdc)), LENDER);
        address[4] memory wallets = [LENDER, BORROWER, BIDDER, OTHER];
        for (uint256 index; index < wallets.length; index++) {
            usdc.mint(wallets[index], 1000e6);
            vm.prank(wallets[index]);
            usdc.approve(address(bank), type(uint256).max);
        }
    }

    function item(address owner) internal returns (uint256 tokenId) {
        receiptSequence++;
        vm.prank(REGISTRAR);
        tokenId = registry.mintItem(
            owner,
            keccak256("bank fixture server"),
            keccak256("bank fixture world"),
            keccak256(abi.encode("custody", receiptSequence)),
            keccak256("exact deposited sword fixture"),
            keccak256(abi.encode("native receipt", receiptSequence))
        );
    }

    function terms(uint256 tokenId, address borrower) internal view returns (AgentCityBank.LoanTerms memory value) {
        WorldAssetRegistry.Asset memory asset = registry.asset(tokenId);
        value = AgentCityBank.LoanTerms({
            borrower: borrower,
            tokenId: tokenId,
            ownershipNonce: asset.ownershipNonce,
            revision: asset.revision,
            snapshotHash: asset.snapshotHash,
            valuation: 100e6,
            principal: 30e6,
            repayment: 30_300_000,
            term: 60,
            grace: 60,
            offerExpiry: uint48(block.timestamp + 3600),
            auctionDuration: 60,
            auctionReserve: 20e6
        });
    }

    function offer(bytes32 id, uint256 tokenId) internal {
        AgentCityBank.LoanTerms memory value = terms(tokenId, BORROWER);
        vm.prank(LENDER);
        bank.offerLoan(id, value);
    }

    function take(bytes32 id, uint256 tokenId) internal {
        offer(id, tokenId);
        vm.startPrank(BORROWER);
        registry.approve(address(bank), tokenId);
        bank.takeLoan(id, bank.termsHash(id));
        vm.stopPrank();
    }

    function overdue(bytes32 id) internal {
        AgentCityBank.Loan memory value = bank.loan(id);
        vm.warp(uint256(value.dueAt) + value.terms.grace + 1);
        bank.startAuction(id);
    }

    function assertCashAccounted() internal view {
        assertEq(usdc.balanceOf(address(bank)), bank.totalOfferReserves() + bank.totalBidEscrow() + bank.totalCredits());
    }
}

contract AgentCityBankTest is AgentCityBankFixture {
    function testReservedPrincipalRequiresExactBorrowerConsentAndLocksCustody() public {
        bytes32 id = keccak256("agreed offer");
        uint256 tokenId = item(BORROWER);
        AgentCityBank.LoanTerms memory value = terms(tokenId, BORROWER);
        vm.expectRevert("lender only");
        vm.prank(OTHER);
        bank.offerLoan(id, value);
        offer(id, tokenId);
        bytes32 consent = bank.termsHash(id);
        assertEq(bank.totalOfferReserves(), 30e6);
        assertEq(registry.ownerOf(tokenId), BORROWER);
        assertCashAccounted();
        vm.expectRevert("borrower exact consent");
        vm.prank(OTHER);
        bank.takeLoan(id, consent);
        vm.expectRevert("borrower exact consent");
        vm.prank(BORROWER);
        bank.takeLoan(id, bytes32(uint256(1)));
        uint256 beforeBalance = usdc.balanceOf(BORROWER);
        vm.startPrank(BORROWER);
        registry.approve(address(bank), tokenId);
        bank.takeLoan(id, consent);
        vm.stopPrank();
        assertEq(usdc.balanceOf(BORROWER), beforeBalance + 30e6);
        assertEq(registry.ownerOf(tokenId), address(bank));
        assertEq(bank.activeLoan(BORROWER), id);
        assertEq(bank.collateralLoan(tokenId), id);
        assertCashAccounted();
        vm.expectRevert("live offered loan required");
        vm.prank(BORROWER);
        bank.takeLoan(id, consent);
        uint64 lockedNonce = registry.asset(tokenId).ownershipNonce;
        vm.expectRevert("item owner nonce");
        vm.prank(BORROWER);
        registry.requestRedemption(tokenId, lockedNonce, keccak256("forbidden redemption"));
        vm.expectRevert();
        vm.prank(BORROWER);
        registry.transferFrom(address(bank), OTHER, tokenId);
        vm.expectRevert("claim binding");
        vm.prank(REGISTRAR);
        registry.finalizeRedemption(tokenId, keccak256("unknown claim"), keccak256("fake delivery"));
        assertEq(registry.ownerOf(tokenId), address(bank));
    }

    function testFundingCannotOvercommitAndCancelledReserveHasSinglePullRefund() public {
        vm.prank(LENDER);
        usdc.transfer(OTHER, 970e6);
        uint256 first = item(BORROWER);
        uint256 second = item(BORROWER);
        bytes32 id = keccak256("only funded offer");
        offer(id, first);
        AgentCityBank.LoanTerms memory value = terms(second, BORROWER);
        vm.expectRevert();
        vm.prank(LENDER);
        bank.offerLoan(keccak256("unfunded offer"), value);
        assertEq(bank.totalOfferReserves(), 30e6);
        assertCashAccounted();
        vm.prank(BORROWER);
        bank.cancelOffer(id);
        assertEq(bank.credits(LENDER), 30e6);
        assertEq(bank.totalOfferReserves(), 0);
        assertCashAccounted();
        vm.prank(LENDER);
        bank.withdraw(LENDER);
        assertEq(usdc.balanceOf(LENDER), 30e6);
        assertCashAccounted();
        vm.expectRevert("withdrawal credit required");
        vm.prank(LENDER);
        bank.withdraw(LENDER);
        vm.expectRevert("loan ID used");
        vm.prank(LENDER);
        bank.offerLoan(id, value);
    }

    function testCapsAssetNonceAndOneActiveLoanRefuseWithoutMovingFunds() public {
        uint256 tokenId = item(BORROWER);
        AgentCityBank.LoanTerms memory value = terms(tokenId, BORROWER);
        value.principal = 30e6 + 1;
        value.repayment = value.principal;
        vm.expectRevert("principal LTV bounds");
        vm.prank(LENDER);
        bank.offerLoan(keccak256("over cap"), value);
        value = terms(tokenId, BORROWER);
        value.valuation = 99e6;
        vm.expectRevert("principal LTV bounds");
        vm.prank(LENDER);
        bank.offerLoan(keccak256("over LTV"), value);
        value = terms(tokenId, BORROWER);
        value.repayment++;
        vm.expectRevert("repayment bounds");
        vm.prank(LENDER);
        bank.offerLoan(keccak256("over fee"), value);
        bytes32 stale = keccak256("stale collateral");
        offer(stale, tokenId);
        vm.prank(BORROWER);
        registry.transferFrom(BORROWER, OTHER, tokenId);
        vm.prank(OTHER);
        registry.transferFrom(OTHER, BORROWER, tokenId);
        vm.prank(BORROWER);
        registry.approve(address(bank), tokenId);
        bytes32 staleConsent = bank.termsHash(stale);
        vm.expectRevert("collateral terms changed");
        vm.prank(BORROWER);
        bank.takeLoan(stale, staleConsent);
        assertEq(bank.totalOfferReserves(), 30e6);
        vm.prank(LENDER);
        bank.cancelOffer(stale);
        uint256 second = item(BORROWER);
        bytes32 active = keccak256("one active");
        take(active, second);
        uint256 third = item(BORROWER);
        bytes32 extra = keccak256("second active");
        offer(extra, third);
        vm.prank(BORROWER);
        registry.approve(address(bank), third);
        bytes32 extraConsent = bank.termsHash(extra);
        vm.expectRevert("borrower already active");
        vm.prank(BORROWER);
        bank.takeLoan(extra, extraConsent);
        assertEq(registry.ownerOf(third), BORROWER);
        assertCashAccounted();
    }

    function testRepaymentClosesOnceAndRejectedReceiverCannotBlockDebtSettlement() public {
        bytes32 id = keccak256("timely repayment");
        uint256 tokenId = item(BORROWER);
        take(id, tokenId);
        vm.warp(bank.loan(id).dueAt);
        uint256 beforeBorrower = usdc.balanceOf(BORROWER);
        vm.prank(BORROWER);
        bank.repay(id);
        assertEq(usdc.balanceOf(BORROWER), beforeBorrower - 30_300_000);
        assertEq(bank.credits(LENDER), 30_300_000);
        assertEq(bank.activeLoan(BORROWER), bytes32(0));
        (uint256 borrowed, uint256 repaid, uint256 timely, uint256 count, uint256 defaults,, uint256 active) =
            bank.history(BORROWER);
        assertEq(borrowed, 30e6);
        assertEq(repaid, 30e6);
        assertEq(timely, 30e6);
        assertEq(count, 1);
        assertEq(defaults, 0);
        assertEq(active, 0);
        assertEq(registry.ownerOf(tokenId), address(bank));
        BankRejectingReceiverFixture rejecting = new BankRejectingReceiverFixture();
        vm.expectRevert("fixture rejects item");
        vm.prank(BORROWER);
        bank.claimCollateral(id, address(rejecting));
        assertEq(uint256(bank.loan(id).state), uint256(AgentCityBank.State.Repaid));
        assertEq(bank.loan(id).collateralClaimant, BORROWER);
        assertEq(bank.credits(LENDER), 30_300_000);
        vm.expectRevert("repayable loan required");
        vm.prank(BORROWER);
        bank.repay(id);
        vm.prank(BORROWER);
        bank.claimCollateral(id, BORROWER);
        assertEq(registry.ownerOf(tokenId), BORROWER);
        assertEq(bank.collateralLoan(tokenId), bytes32(0));
        vm.expectRevert("collateral claimant required");
        vm.prank(BORROWER);
        bank.claimCollateral(id, BORROWER);
        vm.prank(LENDER);
        bank.withdraw(LENDER);
        assertCashAccounted();
    }

    function testAuctionUsesFundedBidsPullRefundsSurplusAndOneSettlement() public {
        bytes32 id = keccak256("surplus auction");
        uint256 tokenId = item(BORROWER);
        take(id, tokenId);
        vm.expectRevert("overdue loan required");
        bank.startAuction(id);
        overdue(id);
        vm.prank(BIDDER);
        bank.bid(id, 31e6);
        vm.prank(OTHER);
        bank.bid(id, 35e6);
        assertEq(bank.credits(BIDDER), 31e6);
        assertEq(bank.totalBidEscrow(), 35e6);
        assertCashAccounted();
        vm.prank(BIDDER);
        bank.withdraw(BIDDER);
        assertCashAccounted();
        vm.warp(bank.loan(id).auctionEnd);
        bank.settleAuction(id);
        assertEq(bank.credits(LENDER), 30_300_000);
        assertEq(bank.credits(BORROWER), 4_700_000);
        assertEq(bank.loan(id).collateralClaimant, OTHER);
        assertEq(bank.totalBidEscrow(), 0);
        assertCashAccounted();
        (,,,, uint256 defaults, uint256 badDebt, uint256 active) = bank.history(BORROWER);
        assertEq(defaults, 1);
        assertEq(badDebt, 0);
        assertEq(active, 0);
        vm.expectRevert("ended auction required");
        bank.settleAuction(id);
        vm.expectRevert("repayable loan required");
        vm.prank(BORROWER);
        bank.repay(id);
        vm.prank(OTHER);
        bank.claimCollateral(id, OTHER);
        assertEq(registry.ownerOf(tokenId), OTHER);
        vm.prank(LENDER);
        bank.withdraw(LENDER);
        vm.prank(BORROWER);
        bank.withdraw(BORROWER);
        assertCashAccounted();
    }

    function testShortfallAndUnsoldForeclosureRecordCashLossWithoutInventingRecovery() public {
        bytes32 id = keccak256("shortfall auction");
        uint256 tokenId = item(BORROWER);
        take(id, tokenId);
        overdue(id);
        vm.prank(BIDDER);
        bank.bid(id, 20e6);
        vm.warp(bank.loan(id).auctionEnd);
        bank.settleAuction(id);
        assertEq(bank.credits(LENDER), 20e6);
        (,,,,, uint256 badDebt,) = bank.history(BORROWER);
        assertEq(badDebt, 10_300_000);
        id = keccak256("unsold collateral");
        tokenId = item(BORROWER);
        take(id, tokenId);
        overdue(id);
        vm.warp(bank.loan(id).auctionEnd);
        bank.settleAuction(id);
        (,,,,, badDebt,) = bank.history(BORROWER);
        assertEq(badDebt, 40_600_000);
        assertEq(bank.credits(LENDER), 20e6);
        assertEq(bank.loan(id).collateralClaimant, LENDER);
        vm.prank(LENDER);
        bank.claimCollateral(id, LENDER);
        assertEq(registry.ownerOf(tokenId), LENDER);
        assertCashAccounted();
    }

    function testRepaymentDuringAuctionRefundsBidAndDefaultIsRecordedOnce() public {
        bytes32 id = keccak256("late repayment");
        uint256 tokenId = item(BORROWER);
        take(id, tokenId);
        overdue(id);
        vm.prank(BIDDER);
        bank.bid(id, 20e6);
        vm.prank(BORROWER);
        bank.repay(id);
        assertEq(bank.credits(LENDER), 30_300_000);
        assertEq(bank.credits(BIDDER), 20e6);
        assertEq(bank.totalBidEscrow(), 0);
        (,,, uint256 timely, uint256 defaults,,) = bank.history(BORROWER);
        assertEq(timely, 0);
        assertEq(defaults, 1);
        assertEq(bank.loan(id).collateralClaimant, BORROWER);
        assertCashAccounted();
        vm.expectRevert("overdue loan required");
        bank.startAuction(id);
        vm.prank(BIDDER);
        bank.withdraw(BIDDER);
        vm.prank(LENDER);
        bank.withdraw(LENDER);
        assertCashAccounted();
    }

    function testLateRepaymentWithoutAuctionStillRecordsDefaultAndInstantRepaymentDoesNotFarmHistory() public {
        bytes32 id = keccak256("instant repayment");
        uint256 tokenId = item(BORROWER);
        take(id, tokenId);
        vm.prank(BORROWER);
        bank.repay(id);
        (,,, uint256 timely, uint256 defaults,,) = bank.history(BORROWER);
        assertEq(timely, 0);
        assertEq(defaults, 0);
        id = keccak256("untriggered late default");
        tokenId = item(BORROWER);
        take(id, tokenId);
        AgentCityBank.Loan memory value = bank.loan(id);
        vm.warp(uint256(value.dueAt) + value.terms.grace + 1);
        vm.prank(BORROWER);
        bank.repay(id);
        (,,, timely, defaults,,) = bank.history(BORROWER);
        assertEq(timely, 0);
        assertEq(defaults, 1);
        assertCashAccounted();
    }
}
