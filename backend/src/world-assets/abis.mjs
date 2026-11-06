import { parseAbi } from 'viem'

// Exact public interfaces of contracts/src/WorldAssetRegistry.sol and Market.sol.
export const registryAbi = parseAbi([
  'function ownerOf(uint256 tokenId) view returns (address)',
  'function getApproved(uint256 tokenId) view returns (address)',
  'function approve(address to,uint256 tokenId)',
  'function asset(uint256 tokenId) view returns ((uint8 kind,bytes32 serverId,bytes32 worldId,bytes32 custodyId,bytes32 snapshotHash,bytes32 nativeReceiptId,bytes32 parcelKey,int32 cellX,int32 cellZ,uint64 ownershipNonce,uint64 revision,bool redemptionPending,bool redeemed))',
  'function claims(bytes32 claimId) view returns (uint256 tokenId,address owner,uint64 expectedOwnershipNonce,bytes32 deliveryReceiptId,bool completed)',
  'function mintItem(address to,bytes32 serverId,bytes32 worldId,bytes32 custodyId,bytes32 snapshotHash,bytes32 nativeReceiptId) returns (uint256)',
  'function mintParcel(address to,bytes32 serverId,bytes32 worldId,int32 cellX,int32 cellZ,bytes32 snapshotHash,bytes32 nativeReceiptId) returns (uint256)',
  'function updateParcelSnapshot(uint256 tokenId,uint64 expectedRevision,bytes32 snapshotHash,bytes32 nativeReceiptId)',
  'function requestRedemption(uint256 tokenId,uint64 expectedOwnershipNonce,bytes32 claimId)',
  'function finalizeRedemption(uint256 tokenId,bytes32 claimId,bytes32 nativeDeliveryReceiptId)',
  'event AssetRegistered(uint256 indexed tokenId,uint8 indexed kind,bytes32 indexed serverId,bytes32 worldId,bytes32 custodyId,bytes32 snapshotHash,bytes32 nativeReceiptId,bytes32 parcelKey)',
  'event AssetOwnershipChanged(uint256 indexed tokenId,address indexed from,address indexed to,uint64 ownershipNonce,uint64 revision)',
  'event ParcelSnapshotUpdated(uint256 indexed tokenId,bytes32 snapshotHash,bytes32 nativeReceiptId,uint64 revision)',
  'event RedemptionRequested(uint256 indexed tokenId,bytes32 indexed claimId,address indexed owner,uint64 ownershipNonce)',
  'event RedemptionFinalized(uint256 indexed tokenId,bytes32 indexed claimId,bytes32 nativeDeliveryReceiptId,address owner)'
])
export const assetMarketAbi = parseAbi([
  'function registry() view returns (address)', 'function city() view returns (address)',
  'function listings(uint256 tokenId) view returns (address seller,uint128 price,uint64 expiry,uint64 ownershipNonce,uint64 revision,uint256 nonce)',
  'function isListingActive(uint256 tokenId) view returns (bool)',
  'function list(uint256 tokenId,uint128 price,uint64 expiry,uint64 expectedOwnershipNonce,uint64 expectedRevision) returns (uint256)',
  'function buy(uint256 tokenId,address expectedSeller,uint128 expectedPrice,uint256 expectedListingNonce,uint64 expectedOwnershipNonce,uint64 expectedRevision)',
  'function cancel(uint256 tokenId,uint256 expectedListingNonce)',
  'event AssetListed(uint256 indexed tokenId,address indexed seller,uint256 indexed listingNonce,uint128 price,uint64 expiry,uint64 ownershipNonce,uint64 revision)',
  'event AssetPurchased(uint256 indexed tokenId,address indexed seller,address indexed buyer,uint128 price,uint256 listingNonce,uint64 ownershipNonce,uint64 revision)',
  'event AssetListingCancelled(uint256 indexed tokenId,address indexed seller,uint256 listingNonce)'
])
export const cityAbi = parseAbi(['function approve(address spender,uint256 amount) returns (bool)', 'function allowance(address owner,address spender) view returns (uint256)', 'function balanceOf(address owner) view returns (uint256)', 'function decimals() view returns (uint8)', 'function symbol() view returns (string)'])
