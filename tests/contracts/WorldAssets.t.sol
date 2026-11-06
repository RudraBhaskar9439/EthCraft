// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC721Receiver} from "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";
import {WorldAssetRegistry} from "agentcity/WorldAssetRegistry.sol";
import {WorldAssetMarket} from "agentcity/WorldAssetMarket.sol";

contract WorldAssetCityFixture is ERC20 {
    constructor() ERC20("CITY fixture", "CITY") {}
    function mint(address to, uint256 amount) external { _mint(to, amount); }
}

contract WorldAssetReceiverFixture is IERC721Receiver {
    WorldAssetMarket public market;
    bool public rejectReceipt;
    bool public reentryBlocked;
    uint256 private tokenId;
    address private seller;
    uint256 private nonce;
    uint64 private ownershipNonce;
    uint64 private revision;
    constructor(WorldAssetMarket market_) { market = market_; }
    function reject(bool value) external { rejectReceipt = value; }
    function purchase(uint256 token, address expectedSeller, uint256 listingNonce, uint64 ownerNonce, uint64 assetRevision) external {
        tokenId = token; seller = expectedSeller; nonce = listingNonce; ownershipNonce = ownerNonce; revision = assetRevision;
        market.city().approve(address(market), 10 ether);
        market.buy(token, expectedSeller, 10 ether, listingNonce, ownerNonce, assetRevision);
    }
    function onERC721Received(address, address, uint256, bytes calldata) external returns (bytes4) {
        require(!rejectReceipt, "fixture rejects NFT");
        try market.buy(tokenId, seller, 10 ether, nonce, ownershipNonce, revision) { revert("unexpected reentry"); }
        catch { reentryBlocked = true; }
        return IERC721Receiver.onERC721Received.selector;
    }
}

/// Actual isolated Foundry EVM tests. Native receipts/rights are disclosed
/// registrar fixtures, not proof of real Minecraft custody or public deployment.
contract WorldAssetContractsTest is Test {
    address admin = address(0xA11);
    address registrar = address(0xA22);
    address seller = address(0xA33);
    address buyer = address(0xA44);
    address other = address(0xA55);
    bytes32 serverId = keccak256("owned fixture server");
    bytes32 worldId = keccak256("fixture world");
    WorldAssetRegistry registry;
    WorldAssetMarket market;
    WorldAssetCityFixture city;

    function setUp() public {
        vm.chainId(31337);
        registry = new WorldAssetRegistry(admin, registrar);
        city = new WorldAssetCityFixture();
        market = new WorldAssetMarket(registry, city);
        city.mint(buyer, 100 ether);
        vm.prank(buyer); city.approve(address(market), 100 ether);
    }
    function item(bytes32 custody, bytes32 receipt) internal returns (uint256) {
        vm.prank(registrar);
        return registry.mintItem(seller, serverId, worldId, custody, keccak256("exact native stack fixture"), receipt);
    }
    function offer(uint256 token) internal returns (uint256 nonce, uint64 ownerNonce, uint64 revision) {
        WorldAssetRegistry.Asset memory value = registry.asset(token);
        vm.startPrank(seller);
        registry.approve(address(market), token);
        nonce = market.list(token, 10 ether, uint64(block.timestamp + 1 hours), value.ownershipNonce, value.revision);
        vm.stopPrank();
        return (nonce, value.ownershipNonce, value.revision);
    }

    function testRegistrarUniqueCustodyCanonicalParcelAndDistinctAdmin() public {
        vm.expectRevert(); vm.prank(admin);
        registry.mintItem(seller, serverId, worldId, bytes32(uint256(1)), bytes32(uint256(2)), bytes32(uint256(3)));
        uint256 token = item(bytes32(uint256(1)), bytes32(uint256(3)));
        assertEq(registry.ownerOf(token), seller);
        vm.expectRevert("custody registered"); item(bytes32(uint256(1)), bytes32(uint256(4)));
        vm.expectRevert("receipt consumed"); item(bytes32(uint256(5)), bytes32(uint256(3)));
        vm.prank(registrar);
        uint256 parcel = registry.mintParcel(seller, serverId, worldId, -1, 2, keccak256("land and house fixture"), bytes32(uint256(6)));
        assertEq(registry.parcelTokens(registry.parcelKey(serverId, worldId, -1, 2)), parcel);
        (int64 minX, int64 maxX, int64 minZ, int64 maxZ) = registry.cellBounds(-1, 2);
        assertEq(minX, -16); assertEq(maxX, -1); assertEq(minZ, 32); assertEq(maxZ, 47);
        assertEq(uint256(registry.asset(parcel).kind), uint256(WorldAssetRegistry.Kind.Parcel));
        vm.expectRevert("parcel registered"); vm.prank(registrar);
        registry.mintParcel(other, serverId, worldId, -1, 2, keccak256("conflicting standalone house"), bytes32(uint256(7)));
        bytes32 registrarRole = registry.REGISTRAR_ROLE();
        vm.expectRevert("distinct roles"); vm.prank(admin); registry.grantRole(registrarRole, admin);
    }

    function testFixedPriceAtomicCityAndNftTradeReplay() public {
        uint256 token = item(bytes32(uint256(10)), bytes32(uint256(11)));
        (uint256 nonce, uint64 ownerNonce, uint64 revision) = offer(token);
        vm.prank(buyer); market.buy(token, seller, 10 ether, nonce, ownerNonce, revision);
        assertEq(registry.ownerOf(token), buyer); assertEq(city.balanceOf(seller), 10 ether); assertEq(city.balanceOf(buyer), 90 ether);
        assertEq(registry.asset(token).ownershipNonce, ownerNonce + 1);
        assertFalse(market.isListingActive(token));
        vm.expectRevert(); vm.prank(buyer); market.buy(token, seller, 10 ether, nonce, ownerNonce, revision);
        assertEq(city.balanceOf(seller), 10 ether); assertEq(city.balanceOf(buyer), 90 ether);
    }

    function testTransferAwayBackAndParcelRevisionInvalidateOldTerms() public {
        uint256 token = item(bytes32(uint256(20)), bytes32(uint256(21)));
        (uint256 nonce, uint64 ownerNonce, uint64 revision) = offer(token);
        vm.prank(seller); registry.transferFrom(seller, other, token);
        vm.prank(other); registry.transferFrom(other, seller, token);
        vm.prank(seller); registry.approve(address(market), token);
        assertFalse(market.isListingActive(token));
        vm.expectRevert(); vm.prank(buyer); market.buy(token, seller, 10 ether, nonce, ownerNonce, revision);
        vm.prank(registrar);
        uint256 parcel = registry.mintParcel(seller, serverId, worldId, 3, 4, keccak256("house revision one"), bytes32(uint256(22)));
        (nonce, ownerNonce, revision) = offer(parcel);
        vm.prank(registrar); registry.updateParcelSnapshot(parcel, revision, keccak256("house revision two"), bytes32(uint256(23)));
        assertFalse(market.isListingActive(parcel));
        vm.expectRevert(); vm.prank(buyer); market.buy(parcel, seller, 10 ether, nonce, ownerNonce, revision);
        assertEq(city.balanceOf(buyer), 100 ether);
    }

    function testRedemptionLocksOriginalClaimAndFinalizesOnce() public {
        uint256 token = item(bytes32(uint256(30)), bytes32(uint256(31)));
        uint64 nonce = registry.asset(token).ownershipNonce;
        bytes32 claim = keccak256("durable native claim fixture");
        bytes32 receipt = bytes32(uint256(32));
        vm.prank(seller); registry.requestRedemption(token, nonce, claim);
        vm.prank(seller); registry.requestRedemption(token, nonce, claim);
        assertEq(registry.asset(token).ownershipNonce, nonce + 1); assertFalse(registry.isTransferable(token));
        vm.expectRevert("redemption locked"); vm.prank(seller); registry.transferFrom(seller, buyer, token);
        vm.expectRevert(); vm.prank(seller); registry.requestRedemption(token, nonce + 1, keccak256("second claim"));
        vm.expectRevert(); vm.prank(admin); registry.finalizeRedemption(token, claim, receipt);
        vm.prank(registrar); registry.finalizeRedemption(token, claim, receipt);
        vm.prank(registrar); registry.finalizeRedemption(token, claim, receipt);
        vm.prank(seller); registry.requestRedemption(token, nonce, claim);
        assertTrue(registry.asset(token).redeemed);
        vm.expectRevert(); registry.ownerOf(token);
        vm.expectRevert("claim receipt binding"); vm.prank(registrar); registry.finalizeRedemption(token, claim, bytes32(uint256(33)));
        vm.expectRevert("receipt consumed"); item(bytes32(uint256(34)), receipt);
    }

    function testSafeReceiverRejectionRollsBackAndReentryCannotPayTwice() public {
        uint256 token = item(bytes32(uint256(40)), bytes32(uint256(41)));
        (uint256 nonce, uint64 ownerNonce, uint64 revision) = offer(token);
        WorldAssetReceiverFixture receiver = new WorldAssetReceiverFixture(market);
        city.mint(address(receiver), 20 ether);
        receiver.reject(true);
        vm.expectRevert("fixture rejects NFT"); receiver.purchase(token, seller, nonce, ownerNonce, revision);
        assertEq(registry.ownerOf(token), seller); assertEq(city.balanceOf(seller), 0); assertEq(city.balanceOf(address(receiver)), 20 ether);
        assertTrue(market.isListingActive(token));
        receiver.reject(false); receiver.purchase(token, seller, nonce, ownerNonce, revision);
        assertTrue(receiver.reentryBlocked()); assertEq(registry.ownerOf(token), address(receiver));
        assertEq(city.balanceOf(seller), 10 ether); assertEq(city.balanceOf(address(receiver)), 10 ether);
    }
}
