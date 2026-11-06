// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {PoolManager} from "@uniswap/v4-core/src/PoolManager.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {SwapParams, ModifyLiquidityParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {PoolSwapTest} from "@uniswap/v4-core/src/test/PoolSwapTest.sol";
import {PoolModifyLiquidityTest} from "@uniswap/v4-core/src/test/PoolModifyLiquidityTest.sol";
import {CreditToken} from "agentcity/CreditToken.sol";
import {KitCustody} from "agentcity/KitCustody.sol";
import {StateRegistry} from "agentcity/StateRegistry.sol";
import {AgentCityHook} from "agentcity/AgentCityHook.sol";
import {Procurement} from "agentcity/Procurement.sol";
import {JobEscrow} from "agentcity/JobEscrow.sol";

contract HookFactory {
    function deploy(bytes32 salt, bytes memory code) external returns (address deployed) {
        assembly { deployed := create2(0, add(code, 32), mload(code), salt) }
        require(deployed != address(0), "hook deployment");
    }
}

/// Local EVM integration using the actual official v4 manager and liquidity/swap test utilities.
contract AgentCityTest is Test {
    CreditToken internal cred;
    KitCustody internal kit;
    StateRegistry internal registry;
    AgentCityHook internal hook;
    Procurement internal procurement;
    JobEscrow internal escrow;
    PoolManager internal manager;
    PoolModifyLiquidityTest internal liquidityRouter;
    PoolSwapTest internal swapRouter;
    PoolKey internal key;
    address internal requester;
    address internal builder;
    address internal attestor;
    address internal constant WAREHOUSE = address(0xBEEF);
    address internal constant PUBLISHER = address(0xCAFE);
    address internal constant ISSUER = address(0x1550);
    uint256[6] internal bill = [uint256(65), 4, 16, 37, 19, 3];
    bytes32 internal constant JOB = keccak256("local-job");

    function setUp() public {
        vm.warp(1000);
        requester = vm.addr(1);
        builder = vm.addr(2);
        attestor = vm.addr(3);
        cred = new CreditToken(address(this), ISSUER);
        kit = new KitCustody(ISSUER, WAREHOUSE, keccak256("local-server"), keccak256("calculator-v1-bundle"), bill);
        registry = new StateRegistry(PUBLISHER, keccak256("local-cred-kit"));
        manager = new PoolManager(address(this));
        hook = deployHook();
        key = PoolKey({
            currency0: Currency.wrap(address(cred) < address(kit) ? address(cred) : address(kit)),
            currency1: Currency.wrap(address(cred) < address(kit) ? address(kit) : address(cred)),
            fee: 3000,
            tickSpacing: 60,
            hooks: IHooks(address(hook))
        });
        manager.initialize(key, uint160(1 << 96));
        liquidityRouter = new PoolModifyLiquidityTest(manager);
        swapRouter = new PoolSwapTest(manager);
        procurement = new Procurement(manager, cred, kit, key);
        escrow = new JobEscrow(cred, address(kit), attestor);
        vm.startPrank(ISSUER);
        cred.mint(address(this), 10000e18);
        cred.mint(requester, 1000e18);
        uint256[6] memory stock;
        for (uint256 item; item < 6; item++) stock[item] = bill[item] * 1000;
        kit.depositAndIssue(keccak256("seeded-stock"), address(this), 1000, stock);
        vm.stopPrank();
        cred.approve(address(liquidityRouter), type(uint256).max);
        kit.approve(address(liquidityRouter), type(uint256).max);
        cred.approve(address(swapRouter), type(uint256).max);
        kit.approve(address(swapRouter), type(uint256).max);
        liquidityRouter.modifyLiquidity(key, ModifyLiquidityParams(-600, 600, 100e18, bytes32(0)), "");
        vm.prank(PUBLISHER);
        registry.publish(1, true, uint64(block.timestamp + 300));
        vm.startPrank(requester);
        cred.approve(address(procurement), type(uint256).max);
        cred.approve(address(escrow), type(uint256).max);
        vm.stopPrank();
    }

    function deployHook() internal returns (AgentCityHook deployed) {
        HookFactory factory = new HookFactory();
        bytes memory code = abi.encodePacked(type(AgentCityHook).creationCode, abi.encode(manager, registry, address(cred), address(kit)));
        bytes32 codeHash = keccak256(code);
        for (uint256 nonce; ; nonce++) {
            bytes32 salt = bytes32(nonce);
            address predicted = address(uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), address(factory), salt, codeHash)))));
            if (uint160(predicted) & Hooks.ALL_HOOK_MASK == Hooks.BEFORE_SWAP_FLAG) {
                deployed = AgentCityHook(factory.deploy(salt, code));
                assertEq(address(deployed), predicted);
                return deployed;
            }
        }
    }

    function testWholeIssueReplayAndPendingBacking() public {
        uint256[6] memory exact = bill;
        bytes32 deposit = keccak256("extra-deposit");
        vm.prank(ISSUER);
        kit.depositAndIssue(deposit, requester, 1, exact);
        vm.prank(ISSUER);
        vm.expectRevert("deposit replay");
        kit.depositAndIssue(deposit, builder, 1, exact);
        uint256 stockBefore = kit.controlledStock(0);
        vm.prank(requester);
        bytes32 claimId = kit.redeem(1, JOB, requester, keccak256("destination"));
        assertEq(kit.pendingKits(), 1);
        assertEq(kit.controlledStock(0), stockBefore, "Burned pending claims keep their backing");
        assertTrue(kit.backed());
        vm.prank(WAREHOUSE);
        kit.markDelivered(claimId, keccak256("synthetic-delivery-receipt"));
        assertEq(kit.pendingKits(), 0);
        assertEq(kit.controlledStock(0), stockBefore - 65);
        vm.prank(WAREHOUSE);
        vm.expectRevert("claim replay");
        kit.markDelivered(claimId, keccak256("another-receipt"));
    }

    function testUnauthorizedAndIncompleteDepositsRefused() public {
        uint256[6] memory stock = bill;
        vm.prank(requester);
        vm.expectRevert("issuer");
        kit.depositAndIssue(keccak256("foreign"), requester, 1, stock);
        stock[0]--;
        uint256 supplyBefore = kit.totalSupply();
        vm.prank(ISSUER);
        vm.expectRevert("incomplete bundle");
        kit.depositAndIssue(keccak256("short"), requester, 1, stock);
        assertEq(kit.totalSupply(), supplyBefore);
        assertTrue(kit.backed());
    }

    function testIssuerSeparatedFromAdministratorAndOtherRoles() public {
        assertEq(cred.owner(), address(this));
        assertEq(cred.issuer(), ISSUER);
        assertEq(kit.issuer(), ISSUER);
        address[6] memory nonIssuers = [address(this), WAREHOUSE, PUBLISHER, attestor, requester, builder];
        uint256[6] memory stock = bill;
        for (uint256 index; index < nonIssuers.length; index++) {
            vm.prank(nonIssuers[index]);
            vm.expectRevert("issuer");
            cred.mint(requester, 1e18);
            vm.prank(nonIssuers[index]);
            vm.expectRevert("issuer");
            kit.depositAndIssue(keccak256("wrong-role"), requester, 1, stock);
        }
        vm.prank(ISSUER);
        cred.mint(requester, 1e18);
        vm.expectRevert("separate issuer");
        cred.transferOwnership(ISSUER);
        vm.expectRevert("separate issuer");
        new CreditToken(address(this), address(this));
    }

    function testFractionalTransfersRetainBackingAndCannotRedeemPartialKit() public {
        kit.transfer(requester, 0.5e18);
        assertTrue(kit.backed());
        vm.prank(requester);
        vm.expectRevert();
        kit.redeem(1, JOB, requester, keccak256("destination"));
        assertEq(kit.pendingKits(), 0);
    }

    function testActualV4ExactOutputPurchaseBurnAndDelivery() public {
        uint256 beforeCred = cred.balanceOf(requester);
        vm.prank(requester);
        (bytes32 claimId, uint256 spent) = procurement.buyAndRedeem(JOB, 1, 2e18, uint64(block.timestamp + 60), keccak256("destination"));
        assertGt(spent, 1e18);
        assertLt(spent, 2e18);
        assertEq(cred.balanceOf(requester), beforeCred - spent);
        assertEq(kit.balanceOf(address(procurement)), 0);
        assertEq(kit.pendingKits(), 1);
        assertTrue(kit.backed());
        (, address recipient,, uint256 kits, bool delivered) = kit.claims(claimId);
        assertEq(recipient, requester);
        assertEq(kits, 1);
        assertFalse(delivered);
    }

    function testPurchaseCapAndInvalidClaimRevertEntireSwap() public {
        uint256 beforeCred = cred.balanceOf(requester);
        uint256 beforeSupply = kit.totalSupply();
        vm.prank(requester);
        vm.expectRevert("purchase cap");
        procurement.buyAndRedeem(JOB, 1, 1, uint64(block.timestamp + 60), keccak256("destination"));
        vm.prank(requester);
        vm.expectRevert("claim terms");
        procurement.buyAndRedeem(JOB, 1, 2e18, uint64(block.timestamp + 60), bytes32(0));
        assertEq(cred.balanceOf(requester), beforeCred);
        assertEq(kit.totalSupply(), beforeSupply);
        assertEq(kit.pendingKits(), 0);
    }

    function swap(bool zeroForOne) internal {
        swapRouter.swap(key, SwapParams(zeroForOne, -int256(0.01e18), zeroForOne ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1),
            PoolSwapTest.TestSettings(false, false), "");
    }

    function testSymmetricHaltLeavesActualLiquidityWithdrawalAvailable() public {
        vm.prank(PUBLISHER);
        registry.publish(2, false, uint64(block.timestamp + 300));
        vm.expectRevert();
        this.externalSwap(true);
        vm.expectRevert();
        this.externalSwap(false);
        liquidityRouter.modifyLiquidity(key, ModifyLiquidityParams(-600, 600, -int256(100e18), bytes32(0)), "");
        assertTrue(kit.backed());
    }

    function externalSwap(bool direction) external { swap(direction); }

    function testRegistryRejectsUnauthorizedReplayAndExactExpiry() public {
        vm.expectRevert("publisher");
        registry.publish(2, true, uint64(block.timestamp + 60));
        vm.prank(PUBLISHER);
        vm.expectRevert("sequence");
        registry.publish(1, true, uint64(block.timestamp + 60));
        vm.warp(registry.validUntil());
        assertFalse(registry.available());
        vm.expectRevert();
        this.externalSwap(true);
        vm.expectRevert();
        this.externalSwap(false);
    }

    function agreement(bytes32 jobId) internal view returns (JobEscrow.Agreement memory terms, address[] memory recipients, uint256[] memory amounts) {
        recipients = new address[](2);
        recipients[0] = builder;
        recipients[1] = address(0x777);
        amounts = new uint256[](2);
        amounts[0] = 6e18;
        amounts[1] = 2e18;
        terms = JobEscrow.Agreement(jobId, keccak256("server"), 1, requester, builder, address(cred), address(kit),
            kit.bundleHash(), keccak256("blueprint"), keccak256("tests"), keccak256("access"), keccak256("scope"),
            3e18, keccak256(abi.encode(recipients, amounts)), uint64(block.timestamp + 3600),
            uint64(block.timestamp + 4500), uint64(block.timestamp + 4500), uint64(block.timestamp + 4500));
    }

    function signature(uint256 privateKey, bytes32 digest) internal pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(privateKey, digest);
        return abi.encodePacked(r, s, v);
    }

    function fund(bytes32 jobId) internal returns (JobEscrow.Agreement memory terms) {
        address[] memory recipients;
        uint256[] memory amounts;
        (terms, recipients, amounts) = agreement(jobId);
        bytes32 digest = escrow.hashAgreement(terms);
        bytes memory requesterSig = signature(1, digest);
        bytes memory builderSig = signature(2, digest);
        vm.prank(requester);
        escrow.fund(terms, recipients, amounts, requesterSig, builderSig);
    }

    function inspection(JobEscrow.Agreement memory terms) internal view returns (JobEscrow.Inspection memory) {
        return JobEscrow.Inspection(terms.jobId, escrow.hashAgreement(terms), terms.blueprintHash, terms.testsHash,
            keccak256("synthetic-16-row-report"), keccak256("synthetic-protected-lock"), 144,
            uint64(block.timestamp), terms.passDeadline, true, 16, 16);
    }

    function testExactApprovalsAcceptancePullClaimsAndLateEntitlement() public {
        JobEscrow.Agreement memory terms = fund(JOB);
        JobEscrow.Inspection memory report = inspection(terms);
        bytes memory attestation = signature(3, escrow.hashInspection(report));
        vm.prank(builder);
        vm.expectRevert("requester");
        escrow.accept(JOB, report, attestation);
        vm.prank(requester);
        escrow.accept(JOB, report, attestation);
        vm.warp(terms.absoluteExpiry + 1);
        vm.prank(builder);
        escrow.claim(JOB);
        assertEq(cred.balanceOf(builder), 6e18);
        vm.prank(builder);
        vm.expectRevert("claim replay");
        escrow.claim(JOB);
        vm.prank(address(0x777));
        escrow.claim(JOB);
        assertEq(cred.balanceOf(address(escrow)), 0);
        vm.prank(requester);
        vm.expectRevert("refund unavailable");
        escrow.refund(JOB);
    }

    function testExactTimeoutRefundExcludesAcceptanceAndReplay() public {
        JobEscrow.Agreement memory terms = fund(JOB);
        JobEscrow.Inspection memory report = inspection(terms);
        bytes memory attestation = signature(3, escrow.hashInspection(report));
        vm.warp(terms.absoluteExpiry);
        vm.prank(requester);
        escrow.refund(JOB);
        assertEq(cred.balanceOf(requester), 1000e18);
        vm.startPrank(requester);
        vm.expectRevert("finalized");
        escrow.accept(JOB, report, attestation);
        vm.expectRevert("refund unavailable");
        escrow.refund(JOB);
        vm.stopPrank();
    }

    function testInvalidatedOrFailedReportCannotAuthorizeDirectAcceptance() public {
        JobEscrow.Agreement memory terms = fund(JOB);
        JobEscrow.Inspection memory report = inspection(terms);
        bytes32 digest = escrow.hashInspection(report);
        bytes memory attestation = signature(3, digest);
        vm.prank(attestor);
        escrow.invalidateReport(digest);
        vm.prank(requester);
        vm.expectRevert("attestation");
        escrow.accept(JOB, report, attestation);
        report.passed = false;
        bytes memory failedAttestation = signature(3, escrow.hashInspection(report));
        vm.prank(requester);
        vm.expectRevert("passing inspection");
        escrow.accept(JOB, report, failedAttestation);
    }

    function testFundingRejectsChangedApprovedTerms() public {
        (JobEscrow.Agreement memory terms, address[] memory recipients, uint256[] memory amounts) = agreement(JOB);
        bytes32 digest = escrow.hashAgreement(terms);
        bytes memory requesterSig = signature(1, digest);
        bytes memory builderSig = signature(2, digest);
        terms.materialCap++;
        vm.prank(requester);
        vm.expectRevert("approvals");
        escrow.fund(terms, recipients, amounts, requesterSig, builderSig);
        assertEq(cred.balanceOf(requester), 1000e18);
    }
}
