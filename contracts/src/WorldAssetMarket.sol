// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {WorldAssetRegistry} from "./WorldAssetRegistry.sol";

/// Fixed CITY testnet settlement for exact registry NFTs. No fee, bidding,
/// implicit agent authority or changeable payment-token configuration.
contract WorldAssetMarket is ReentrancyGuard {
    using SafeERC20 for IERC20;
    WorldAssetRegistry public immutable registry;
    IERC20 public immutable city;
    struct Listing { address seller; uint128 price; uint64 expiry; uint64 ownershipNonce; uint64 revision; uint256 nonce; }
    mapping(uint256 => Listing) public listings;
    mapping(uint256 => uint256) public listingNonces;

    event AssetListed(uint256 indexed tokenId, address indexed seller, uint256 indexed listingNonce, uint128 price, uint64 expiry, uint64 ownershipNonce, uint64 revision);
    event AssetListingCancelled(uint256 indexed tokenId, address indexed seller, uint256 listingNonce);
    event AssetPurchased(uint256 indexed tokenId, address indexed seller, address indexed buyer, uint128 price, uint256 listingNonce, uint64 ownershipNonce, uint64 revision);

    constructor(WorldAssetRegistry registry_, IERC20 city_) {
        require(block.chainid == 31337 || block.chainid == 1301, "testnet only");
        require(address(registry_).code.length > 0 && address(city_).code.length > 0, "deployed assets required");
        registry = registry_; city = city_;
    }

    function _approved(address seller, uint256 tokenId) private view returns (bool) {
        return registry.getApproved(tokenId) == address(this) || registry.isApprovedForAll(seller, address(this));
    }

    function list(uint256 tokenId, uint128 price, uint64 expiry, uint64 expectedOwnershipNonce, uint64 expectedRevision) external nonReentrant returns (uint256 nonce) {
        require(registry.ownerOf(tokenId) == msg.sender && registry.isTransferable(tokenId) && _approved(msg.sender, tokenId), "approved owner required");
        WorldAssetRegistry.Asset memory value = registry.asset(tokenId);
        require(value.ownershipNonce == expectedOwnershipNonce && value.revision == expectedRevision, "asset changed");
        require(price > 0 && expiry > block.timestamp && expiry <= block.timestamp + 30 days, "bounded price expiry");
        nonce = ++listingNonces[tokenId];
        listings[tokenId] = Listing(msg.sender, price, expiry, value.ownershipNonce, value.revision, nonce);
        emit AssetListed(tokenId, msg.sender, nonce, price, expiry, value.ownershipNonce, value.revision);
    }

    function isListingActive(uint256 tokenId) public view returns (bool) {
        Listing memory offer = listings[tokenId];
        if (offer.seller == address(0) || offer.expiry <= block.timestamp || !registry.isTransferable(tokenId)) return false;
        WorldAssetRegistry.Asset memory value = registry.asset(tokenId);
        return registry.ownerOf(tokenId) == offer.seller && value.ownershipNonce == offer.ownershipNonce && value.revision == offer.revision && _approved(offer.seller, tokenId);
    }

    function cancel(uint256 tokenId, uint256 expectedListingNonce) external nonReentrant {
        Listing memory offer = listings[tokenId];
        require(offer.seller == msg.sender && offer.nonce == expectedListingNonce, "listing owner nonce");
        delete listings[tokenId]; ++listingNonces[tokenId];
        emit AssetListingCancelled(tokenId, msg.sender, expectedListingNonce);
    }

    function buy(uint256 tokenId, address expectedSeller, uint128 expectedPrice, uint256 expectedListingNonce, uint64 expectedOwnershipNonce, uint64 expectedRevision) external nonReentrant {
        Listing memory offer = listings[tokenId];
        require(offer.seller == expectedSeller && offer.price == expectedPrice && offer.nonce == expectedListingNonce && offer.ownershipNonce == expectedOwnershipNonce && offer.revision == expectedRevision, "listing terms changed");
        require(msg.sender != offer.seller && isListingActive(tokenId), "active foreign listing required");
        delete listings[tokenId]; ++listingNonces[tokenId];
        uint256 sellerBefore = city.balanceOf(offer.seller);
        uint256 buyerBefore = city.balanceOf(msg.sender);
        city.safeTransferFrom(msg.sender, offer.seller, offer.price);
        require(city.balanceOf(offer.seller) == sellerBefore + offer.price && buyerBefore >= offer.price && city.balanceOf(msg.sender) == buyerBefore - offer.price, "exact CITY payment required");
        // Token callbacks cannot turn a changed asset into the originally
        // accepted order. Any mismatch reverts payment and transfer atomically.
        WorldAssetRegistry.Asset memory beforeTransfer = registry.asset(tokenId);
        require(registry.ownerOf(tokenId) == offer.seller && beforeTransfer.ownershipNonce == offer.ownershipNonce && beforeTransfer.revision == offer.revision && registry.isTransferable(tokenId), "asset changed during payment");
        registry.safeTransferFrom(offer.seller, msg.sender, tokenId);
        WorldAssetRegistry.Asset memory afterTransfer = registry.asset(tokenId);
        emit AssetPurchased(tokenId, offer.seller, msg.sender, offer.price, offer.nonce, afterTransfer.ownershipNonce, afterTransfer.revision);
    }
}
