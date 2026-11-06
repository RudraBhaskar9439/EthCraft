// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IERC721Receiver} from "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {SafeCallback} from "@uniswap/v4-periphery/src/base/SafeCallback.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {WorldAssetMarket} from "./WorldAssetMarket.sol";
import {WorldAssetRegistry} from "./WorldAssetRegistry.sol";

/// One-chain allowlisted exchange and exact-item checkout. The caller is always
/// the payer; accepting a user-supplied payer would break reputation binding.
contract BankPaymentRouter is SafeCallback, ReentrancyGuard, IERC721Receiver {
    using SafeERC20 for IERC20;

    struct Checkout {
        uint256 tokenId;
        address seller;
        uint128 price;
        uint256 listingNonce;
        uint64 ownershipNonce;
        uint64 revision;
    }

    WorldAssetMarket public immutable market;
    WorldAssetRegistry public immutable registry;
    IERC20 public immutable city;
    IERC20 public immutable usdc;
    IERC20 public immutable gem;
    PoolKey public cityUsdcPool;
    PoolKey public gemUsdcPool;
    mapping(address => mapping(bytes32 => bool)) public operationUsed;
    uint256 private receivingTokenId;
    address private receivingSeller;

    event SwapExecuted(
        bytes32 indexed operationId,
        address indexed trader,
        address indexed tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 amountOut
    );
    event CheckoutPurchased(
        bytes32 indexed operationId,
        address indexed buyer,
        uint256 indexed tokenId,
        address seller,
        address tokenIn,
        uint256 amountIn,
        uint256 cityPrice,
        uint256 listingNonce,
        uint64 ownershipNonce
    );

    constructor(
        IPoolManager manager,
        WorldAssetMarket market_,
        IERC20 usdc_,
        PoolKey memory cityPool,
        PoolKey memory gemPool
    ) SafeCallback(manager) {
        require(block.chainid == 31337 || block.chainid == 1301, "testnet only");
        require(
            address(manager).code.length > 0 && address(market_).code.length > 0 && address(usdc_).code.length > 0,
            "deployed contracts required"
        );
        market = market_;
        registry = market_.registry();
        city = market_.city();
        usdc = usdc_;
        require(address(city) != address(usdc_), "distinct tokens");
        require(
            _pair(cityPool, address(city), address(usdc_)) && cityPool.fee == 0x800000 && cityPool.tickSpacing == 60
                && address(cityPool.hooks).code.length > 0,
            "dynamic CITY pool required"
        );
        address coin = Currency.unwrap(gemPool.currency0) == address(usdc_)
            ? Currency.unwrap(gemPool.currency1)
            : Currency.unwrap(gemPool.currency0);
        require(
            coin != address(city) && coin != address(usdc_) && coin.code.length > 0
                && _pair(gemPool, coin, address(usdc_)) && gemPool.fee == 3000 && gemPool.tickSpacing == 60
                && address(gemPool.hooks) == address(0),
            "plain GEM pool required"
        );
        gem = IERC20(coin);
        cityUsdcPool = cityPool;
        gemUsdcPool = gemPool;
    }

    function hook() external view returns (address) {
        return address(cityUsdcPool.hooks);
    }

    function poolKey() external view returns (PoolKey memory) {
        return cityUsdcPool;
    }

    function _pair(PoolKey memory key, address a, address b) private pure returns (bool) {
        return Currency.unwrap(key.currency0) == (a < b ? a : b) && Currency.unwrap(key.currency1) == (a < b ? b : a);
    }

    function _supported(address token) private view returns (bool) {
        return token == address(city) || token == address(usdc) || token == address(gem);
    }

    function _begin(bytes32 operationId, uint128 amountOut, uint128 maxAmountIn, uint48 deadline) private {
        require(operationId != 0 && !operationUsed[msg.sender][operationId], "operation used");
        require(block.timestamp < deadline && deadline <= block.timestamp + 120, "quote expired");
        require(
            amountOut > 0 && amountOut <= uint128(type(int128).max) && maxAmountIn > 0
                && maxAmountIn <= uint128(type(int128).max),
            "swap bounds"
        );
        operationUsed[msg.sender][operationId] = true;
    }

    function swapExactOutput(
        bytes32 operationId,
        address tokenIn,
        address tokenOut,
        uint128 amountOut,
        uint128 maxAmountIn,
        uint48 deadline
    ) external nonReentrant returns (uint256 amountIn) {
        _begin(operationId, amountOut, maxAmountIn, deadline);
        amountIn = _exchange(msg.sender, tokenIn, tokenOut, amountOut, maxAmountIn, msg.sender);
        emit SwapExecuted(operationId, msg.sender, tokenIn, tokenOut, amountIn, amountOut);
    }

    function buyWithSwap(
        bytes32 operationId,
        address tokenIn,
        uint128 maxAmountIn,
        uint48 deadline,
        Checkout calldata terms
    ) external nonReentrant returns (uint256 amountIn) {
        _begin(operationId, terms.price, maxAmountIn, deadline);
        require(_supported(tokenIn) && terms.seller != msg.sender, "foreign supported purchase required");
        WorldAssetRegistry.Asset memory beforeAsset = registry.asset(terms.tokenId);
        require(
            beforeAsset.kind == WorldAssetRegistry.Kind.Item && !beforeAsset.redemptionPending && !beforeAsset.redeemed
                && beforeAsset.ownershipNonce == terms.ownershipNonce && beforeAsset.revision == terms.revision
                && registry.ownerOf(terms.tokenId) == terms.seller,
            "exact item required"
        );
        uint256 beforeCity = city.balanceOf(address(this));
        if (tokenIn == address(city)) {
            require(terms.price <= maxAmountIn, "maximum input");
            city.safeTransferFrom(msg.sender, address(this), terms.price);
            amountIn = terms.price;
        } else {
            amountIn = _exchange(msg.sender, tokenIn, address(city), terms.price, maxAmountIn, address(this));
        }
        require(city.balanceOf(address(this)) == beforeCity + terms.price, "exact checkout funding");
        receivingTokenId = terms.tokenId;
        receivingSeller = terms.seller;
        city.forceApprove(address(market), terms.price);
        market.buy(terms.tokenId, terms.seller, terms.price, terms.listingNonce, terms.ownershipNonce, terms.revision);
        city.forceApprove(address(market), 0);
        receivingTokenId = 0;
        receivingSeller = address(0);
        registry.safeTransferFrom(address(this), msg.sender, terms.tokenId);
        WorldAssetRegistry.Asset memory afterAsset = registry.asset(terms.tokenId);
        require(
            registry.ownerOf(terms.tokenId) == msg.sender
                && uint256(afterAsset.ownershipNonce) == uint256(terms.ownershipNonce) + 2
                && afterAsset.snapshotHash == beforeAsset.snapshotHash && afterAsset.revision == terms.revision
                && city.balanceOf(address(this)) == beforeCity,
            "checkout conservation"
        );
        emit CheckoutPurchased(
            operationId,
            msg.sender,
            terms.tokenId,
            terms.seller,
            tokenIn,
            amountIn,
            terms.price,
            terms.listingNonce,
            afterAsset.ownershipNonce
        );
    }

    function onERC721Received(address operator, address from, uint256 tokenId, bytes calldata)
        external
        view
        returns (bytes4)
    {
        require(
            msg.sender == address(registry) && operator == address(market) && tokenId != 0
                && tokenId == receivingTokenId && from == receivingSeller,
            "expected checkout NFT only"
        );
        return IERC721Receiver.onERC721Received.selector;
    }

    function _exchange(
        address payer,
        address tokenIn,
        address tokenOut,
        uint128 amountOut,
        uint128 maximum,
        address recipient
    ) private returns (uint256) {
        require(_supported(tokenIn) && _supported(tokenOut) && tokenIn != tokenOut, "unsupported route");
        return
            abi.decode(
                poolManager.unlock(abi.encode(payer, tokenIn, tokenOut, amountOut, maximum, recipient)), (uint256)
            );
    }

    function _pool(address token) private view returns (PoolKey memory) {
        require(token == address(city) || token == address(gem), "unsupported pool");
        return token == address(city) ? cityUsdcPool : gemUsdcPool;
    }

    function _swapOutput(PoolKey memory key, address tokenIn, uint128 amountOut, address payer)
        private
        returns (uint256 amountIn)
    {
        bool zeroForOne = tokenIn == Currency.unwrap(key.currency0);
        BalanceDelta delta = poolManager.swap(
            key,
            SwapParams({
                zeroForOne: zeroForOne,
                amountSpecified: int256(uint256(amountOut)),
                sqrtPriceLimitX96: zeroForOne ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1
            }),
            abi.encode(payer)
        );
        int128 inputDelta = zeroForOne ? delta.amount0() : delta.amount1();
        int128 outputDelta = zeroForOne ? delta.amount1() : delta.amount0();
        require(inputDelta < 0 && outputDelta > 0 && uint128(outputDelta) == amountOut, "incomplete exact output");
        amountIn = uint256(-int256(inputDelta));
    }

    function _unlockCallback(bytes calldata data) internal override returns (bytes memory) {
        (address payer, address tokenIn, address tokenOut, uint128 amountOut, uint128 maximum, address recipient) =
            abi.decode(data, (address, address, address, uint128, uint128, address));
        uint256 amountIn;
        if (tokenIn == address(usdc)) {
            amountIn = _swapOutput(_pool(tokenOut), tokenIn, amountOut, payer);
        } else if (tokenOut == address(usdc)) {
            amountIn = _swapOutput(_pool(tokenIn), tokenIn, amountOut, payer);
        } else {
            uint256 intermediate = _swapOutput(_pool(tokenOut), address(usdc), amountOut, payer);
            require(intermediate <= uint128(type(int128).max), "intermediate bound");
            amountIn = _swapOutput(_pool(tokenIn), tokenIn, uint128(intermediate), payer);
        }
        require(amountIn <= maximum, "maximum input");
        poolManager.sync(Currency.wrap(tokenIn));
        IERC20(tokenIn).safeTransferFrom(payer, address(poolManager), amountIn);
        require(poolManager.settle() == amountIn, "exact settlement");
        poolManager.take(Currency.wrap(tokenOut), recipient, amountOut);
        return abi.encode(amountIn);
    }
}
