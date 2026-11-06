// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.26;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// Testnet rights registry. A trusted registrar attests native custody/rights;
/// hashes alone do not prove Minecraft inventory or land ownership.
contract WorldAssetRegistry is ERC721, AccessControl, ReentrancyGuard {
    bytes32 public constant REGISTRAR_ROLE = keccak256("REGISTRAR_ROLE");
    int64 public constant CELL_SIZE = 16;
    enum Kind { None, Item, Parcel }
    struct Asset {
        Kind kind;
        bytes32 serverId;
        bytes32 worldId;
        bytes32 custodyId;
        bytes32 snapshotHash;
        bytes32 nativeReceiptId;
        bytes32 parcelKey;
        int32 cellX;
        int32 cellZ;
        uint64 ownershipNonce;
        uint64 revision;
        bool redemptionPending;
        bool redeemed;
    }
    struct Claim {
        uint256 tokenId;
        address owner;
        uint64 expectedOwnershipNonce;
        bytes32 deliveryReceiptId;
        bool completed;
    }
    uint256 public nextTokenId = 1;
    mapping(uint256 => Asset) private _assets;
    mapping(bytes32 => bool) public usedNativeReceipts;
    mapping(bytes32 => uint256) public custodyTokens;
    mapping(bytes32 => uint256) public parcelTokens;
    mapping(bytes32 => Claim) public claims;

    event AssetRegistered(uint256 indexed tokenId, Kind indexed kind, bytes32 indexed serverId, bytes32 worldId, bytes32 custodyId, bytes32 snapshotHash, bytes32 nativeReceiptId, bytes32 parcelKey);
    event AssetOwnershipChanged(uint256 indexed tokenId, address indexed from, address indexed to, uint64 ownershipNonce, uint64 revision);
    event ParcelSnapshotUpdated(uint256 indexed tokenId, bytes32 snapshotHash, bytes32 nativeReceiptId, uint64 revision);
    event RedemptionRequested(uint256 indexed tokenId, bytes32 indexed claimId, address indexed owner, uint64 ownershipNonce);
    event RedemptionFinalized(uint256 indexed tokenId, bytes32 indexed claimId, bytes32 nativeDeliveryReceiptId, address owner);

    constructor(address administrator, address registrar) ERC721("AgentCity World Assets", "ACWA") {
        require(block.chainid == 31337 || block.chainid == 1301, "testnet only");
        require(administrator != address(0) && registrar != address(0) && administrator != registrar, "distinct roles");
        _grantRole(DEFAULT_ADMIN_ROLE, administrator);
        _grantRole(REGISTRAR_ROLE, registrar);
    }

    function grantRole(bytes32 role, address account) public override {
        require(account != address(0), "zero role");
        require(!(role == REGISTRAR_ROLE && hasRole(DEFAULT_ADMIN_ROLE, account)) && !(role == DEFAULT_ADMIN_ROLE && hasRole(REGISTRAR_ROLE, account)), "distinct roles");
        super.grantRole(role, account);
    }

    function asset(uint256 tokenId) external view returns (Asset memory) {
        require(_assets[tokenId].kind != Kind.None, "unknown asset");
        return _assets[tokenId];
    }

    function parcelKey(bytes32 serverId, bytes32 worldId, int32 cellX, int32 cellZ) public pure returns (bytes32) {
        return keccak256(abi.encode(serverId, worldId, cellX, cellZ));
    }

    function cellBounds(int32 cellX, int32 cellZ) external pure returns (int64 minX, int64 maxX, int64 minZ, int64 maxZ) {
        minX = int64(cellX) * CELL_SIZE; minZ = int64(cellZ) * CELL_SIZE;
        return (minX, minX + CELL_SIZE - 1, minZ, minZ + CELL_SIZE - 1);
    }

    function _receipt(bytes32 receiptId) private {
        require(receiptId != bytes32(0) && !usedNativeReceipts[receiptId], "receipt consumed");
        usedNativeReceipts[receiptId] = true;
    }

    function mintItem(address to, bytes32 serverId, bytes32 worldId, bytes32 custodyId, bytes32 snapshotHash, bytes32 nativeReceiptId)
        external onlyRole(REGISTRAR_ROLE) nonReentrant returns (uint256 tokenId)
    {
        require(serverId != 0 && worldId != 0 && custodyId != 0 && snapshotHash != 0, "native terms");
        bytes32 key = keccak256(abi.encode(serverId, worldId, custodyId));
        require(custodyTokens[key] == 0, "custody registered");
        _receipt(nativeReceiptId);
        tokenId = nextTokenId++;
        _assets[tokenId] = Asset(Kind.Item, serverId, worldId, custodyId, snapshotHash, nativeReceiptId, 0, 0, 0, 0, 1, false, false);
        custodyTokens[key] = tokenId;
        _safeMint(to, tokenId);
        emit AssetRegistered(tokenId, Kind.Item, serverId, worldId, custodyId, snapshotHash, nativeReceiptId, 0);
    }

    /// One deed owns the entire fixed cell including its house snapshot. There
    /// is no independently transferable house NFT with conflicting rights.
    function mintParcel(address to, bytes32 serverId, bytes32 worldId, int32 cellX, int32 cellZ, bytes32 snapshotHash, bytes32 nativeReceiptId)
        external onlyRole(REGISTRAR_ROLE) nonReentrant returns (uint256 tokenId)
    {
        require(serverId != 0 && worldId != 0 && snapshotHash != 0, "native terms");
        bytes32 key = parcelKey(serverId, worldId, cellX, cellZ);
        require(parcelTokens[key] == 0, "parcel registered");
        _receipt(nativeReceiptId);
        tokenId = nextTokenId++;
        _assets[tokenId] = Asset(Kind.Parcel, serverId, worldId, 0, snapshotHash, nativeReceiptId, key, cellX, cellZ, 0, 1, false, false);
        parcelTokens[key] = tokenId;
        _safeMint(to, tokenId);
        emit AssetRegistered(tokenId, Kind.Parcel, serverId, worldId, 0, snapshotHash, nativeReceiptId, key);
    }

    function updateParcelSnapshot(uint256 tokenId, uint64 expectedRevision, bytes32 snapshotHash, bytes32 nativeReceiptId)
        external onlyRole(REGISTRAR_ROLE) nonReentrant
    {
        Asset storage value = _assets[tokenId];
        require(value.kind == Kind.Parcel && value.revision == expectedRevision && snapshotHash != 0, "parcel revision");
        _receipt(nativeReceiptId);
        value.snapshotHash = snapshotHash; value.nativeReceiptId = nativeReceiptId; value.revision++;
        emit ParcelSnapshotUpdated(tokenId, snapshotHash, nativeReceiptId, value.revision);
    }

    function isTransferable(uint256 tokenId) public view returns (bool) {
        Asset storage value = _assets[tokenId];
        return _ownerOf(tokenId) != address(0) && !value.redemptionPending && !value.redeemed;
    }

    function requestRedemption(uint256 tokenId, uint64 expectedOwnershipNonce, bytes32 claimId) external nonReentrant {
        require(claimId != 0, "claim required");
        Claim storage previous = claims[claimId];
        if (previous.tokenId != 0) {
            require(previous.tokenId == tokenId && previous.owner == msg.sender && previous.expectedOwnershipNonce == expectedOwnershipNonce, "claim binding");
            return;
        }
        Asset storage value = _assets[tokenId];
        require(value.kind == Kind.Item && ownerOf(tokenId) == msg.sender && value.ownershipNonce == expectedOwnershipNonce && !value.redemptionPending, "item owner nonce");
        value.redemptionPending = true; value.ownershipNonce++;
        claims[claimId] = Claim(tokenId, msg.sender, expectedOwnershipNonce, 0, false);
        emit RedemptionRequested(tokenId, claimId, msg.sender, value.ownershipNonce);
    }

    /// Call only after the durable native receiver assigned the original exact
    /// custody to this claim's owner. Unknown native effects keep the NFT locked.
    function finalizeRedemption(uint256 tokenId, bytes32 claimId, bytes32 nativeDeliveryReceiptId) external onlyRole(REGISTRAR_ROLE) nonReentrant {
        Claim storage claim = claims[claimId];
        require(claim.tokenId == tokenId && claim.owner != address(0), "claim binding");
        if (claim.completed) { require(claim.deliveryReceiptId == nativeDeliveryReceiptId, "claim receipt binding"); return; }
        Asset storage value = _assets[tokenId];
        require(value.kind == Kind.Item && value.redemptionPending && ownerOf(tokenId) == claim.owner, "pending item claim");
        _receipt(nativeDeliveryReceiptId);
        claim.completed = true; claim.deliveryReceiptId = nativeDeliveryReceiptId;
        value.redemptionPending = false; value.redeemed = true;
        _burn(tokenId);
        emit RedemptionFinalized(tokenId, claimId, nativeDeliveryReceiptId, claim.owner);
    }

    function _update(address to, uint256 tokenId, address auth) internal override returns (address from) {
        from = _ownerOf(tokenId);
        if (from != address(0)) require(!_assets[tokenId].redemptionPending, "redemption locked");
        from = super._update(to, tokenId, auth);
        Asset storage value = _assets[tokenId]; value.ownershipNonce++;
        emit AssetOwnershipChanged(tokenId, from, to, value.ownershipNonce, value.revision);
    }

    function supportsInterface(bytes4 interfaceId) public view override(ERC721, AccessControl) returns (bool) {
        return super.supportsInterface(interfaceId);
    }
}
