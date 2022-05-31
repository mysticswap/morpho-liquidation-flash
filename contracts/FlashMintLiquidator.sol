pragma solidity 0.8.13;

import "./interface/IERC3156FlashLender.sol";
import "./interface/IERC3156FlashBorrower.sol";
import "./interface/ICompound.sol";
import "./interface/morpho/IMorpho.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import "@rari-capital/solmate/src/utils/SafeTransferLib.sol";

import '@uniswap/v3-periphery/contracts/interfaces/ISwapRouter.sol';

contract FlashMintLiquidator is IERC3156FlashBorrower, Ownable {
    using SafeTransferLib for ERC20;
    using CompoundMath for uint256;

    /// EVENTS ///

    event Liquidated(
        address indexed liquidator,
        address borrower,
        address indexed poolTokenBorrowedAddress,
        address indexed poolTokenCollateralAddress,
        uint256 amount,
        uint256 seized,
        bool usingFlashLoans
    );

    event LiquidatorAdded(
        address indexed _liquidatorAdded
    );

    event LiquidatorRemoved(
        address indexed _liquidatorRemoved
    );

    event Withdrawn(
        address indexed sender,
        address indexed receiver,
        address indexed underlyingAddress,
        uint256 amount
    );


    IMorpho public immutable morpho;
    ICToken public immutable cDai;
    ISwapRouter public immutable uniswapV3Router;
    uint256 public constant BASIS_POINTS = 10000;
    address[] liquidators;

    IERC3156FlashLender lender;

    constructor (
        IERC3156FlashLender lender_,
        IMorpho morpho_,
        IERC20 cDai_
    ) public {
        lender = lender_;
        morpho = morpho_;
        cDai = cDai_;
        liquidators.push(msg.sender);
    }


    function liquidate(
        address _poolTokenBorrowedAddress,
        address _poolTokenCollateralAddress,
        address _borrower,
        uint256 _repayAmount,
        bool _stakeTokens
    ) external nonReentrant {
        uint256 amountSeized;
        ERC20 collateralUnderlying = ERC20(ICToken(_poolTokenCollateralAddress).underlying());
        uint256 collateralBalanceBefore = collateralUnderlying.balanceOf(address(this));

        if(_stakeTokens && liquidators[msg.sender] != address(0)) {
            // only for setted liquidators
            uint256 balanceBefore = ERC20(ICToken(_poolTokenBorrowedAddress).underlying()).balanceOf(address(this));
            if(balanceBefore >= _repayAmount) {
                ERC20 borrowedUnderlying = ERC20(ICToken(_poolTokenBorrowedAddress).underlying());
                borrowedUnderlying.safeApprove(address(morpho), _repayAmount);
                morpho.liquidate(_poolTokenBorrowedAddress, _poolTokenCollateralAddress, _borrower, _repayAmount);
                amountSeized = collateralUnderlying.balanceOf(address(this)) - collateralBalanceBefore;
                emit Liquidated(
                    msg.sender,
                    _borrower,
                    _poolTokenBorrowedAddress,
                    _poolTokenCollateralAddress,
                    _repayAmount,
                    amountSeized,
                    false
                );
                return;
            }
        }

        IComptroller comptroller = IComptroller(morpho.comptroller());
        ICompoundOracle oracle = ICompoundOracle(comptroller.oracle());
        uint256 daiPrice = oracle.getUnderlyingPrice(cDai);
        uint256 borrowedTokenPrice = oracle.getUnderlyingPrice(_poolTokenBorrowedAddress);
        uint256 daiToFlashLoans = _repayAmount.mul(borrowedTokenPrice).div(daiPrice);
        IERC20 dai = IERC20(cDai.underlying());
        uint256 fee = lender.flashFee(dai, daiToFlashLoans);
        IERC20(dai).approve(address(lender), daiToFlashLoans + fee);


        bytes memory data = abi.encode(
            _poolTokenBorrowedAddress,
            _poolTokenCollateralAddress,
            _underlyingTokenBorrowedAddress,
            _underlyingTokenCollateralAddress,
            _borrower,
            _repayAmount,
            daiPrice,
            borrowedTokenPrice // transfer the price to no recompute it
        );
        lender.flashLoan(this, dai, daiToFlashLoans, data);

    }

    /// @dev ERC-3156 Flash loan callback
    function onFlashLoan(
        address initiator,
        address token,
        uint256 amount,
        uint256 fee,
        bytes calldata data
    ) external override returns (bytes32) {
        require(
            msg.sender == address(lender),
            "FlashBorrower: Untrusted lender"
        );
        require(
            initiator == address(this),
            "FlashBorrower: Untrusted loan initiator"
        );
        (
        address _poolTokenBorrowedAddress,
        address _poolTokenCollateralAddress,
        address _underlyingTokenBorrowedAddress,
        address _underlyingTokenCollateralAddress,
        address _borrower,
        uint256 _repayAmount,
        uint256 _daiPrice,
        uint256 _borrowedTokenPrice
        ) = abi.decode(data, (address,address,address,address,address,uint256,uint256,uint256));

        if(token != _underlyingTokenBorrowedAddress) {
            IERC20(token).safeApprove(address(uniswapV3Router, amount));

            uint amountOutMinimumWithSlippage = _repayAmount * (BASIS_POINTS - 100) / BASIS_POINTS;

            ISwapRouter.ExactInputSingleParams memory params =
            ISwapRouter.ExactInputSingleParams({
            tokenIn: token,
            tokenOut: _underlyingTokenBorrowedAddress,
            fee: poolFee,
            recipient: msg.sender,
            deadline: block.timestamp,
            amountIn: amount,
            amountOutMinimum: amountOutMinimumWithSlippage,
            sqrtPriceLimitX96: 0
            });
            uint256 swapped = uniswapV3Router.exactInputSingle(params);
            _repayAmount =  swapped > _repayAmount ? _repayAmount : swapped;// do not repay too much
            if(swapped > _repayAmount) {
                // retrieve the over swapped tokens
                ERC20(_underlyingTokenBorrowedAddress).safeTransfer(initiator, swapped - _repayAmount);
            } else {
                // limit the repay amount to the amount swapped
                _repayAmount = swapped;
            }
        }
        IERC20(_underlyingTokenBorrowedAddress).approve(address(morpho), _repayAmount);
        uint256 balanceBefore = IERC20(_underlyingTokenCollateralAddress).balanceOf(address(this));
        morpho.liquidate(_poolTokenBorrowedAddress, _poolTokenCollateralAddress, _borrower, toRepay);
        uint256 seized = IERC20(_underlyingTokenCollateralAddress).balanceOf(address(this)) - balanceBefore;
        uint256 collateralSwapped;
        if(_underlyingTokenCollateralAddress != token) {
            IERC20(_underlyingTokenCollateralAddress).safeApprove(address(uniswapV3Router), seized);
            ISwapRouter.ExactOutputSingleParams memory outputParams =
                ISwapRouter.ExactOutputSingleParams({
                    tokenIn: _underlyingTokenCollateralAddress,
                    tokenOut: token,
                    fee: poolFee,
                    recipient: msg.sender,
                    deadline: block.timestamp,
                    amountOut: amount + fee,
                    amountInMaximum: seized,
                    sqrtPriceLimitX96: 0
                });
            collateralSwapped = swapRouter.exactOutputSingle(params);
        }
        uint256 bonus = seized - amountIn;
        IERC20(_underlyingTokenCollateralAddress).safeTransfer(initiator, bonus);

        return keccak256("ERC3156FlashBorrower.onFlashLoan");
    }




    function addLiquidator(address _newLiquidator) external onlyOwner {
        liquidators.push(_newLiquidator);
        emit LiquidatorAdded(_newLiquidator);
    }

    function removeLiquidator(address _liquidatorToRemove) external onlyOwner {
        delete liquidators [_liquidatorToRemove];
        emit LiquidatorRemoved(_newLiquidator);
    }


    function deposit(address _underlyingAddress, uint256 _amount) external {
        ERC20(_underlyingAddress).safeTransferFrom(msg.sender, address(this), _amount);
    }

    function withdraw(address _underlyingAddress, address _receiver, uint256 _amount ) external onlyOwner {
        ERC20(_underlyingAddress).safeTransfer(_receiver, _amount);
        emit Withdrawn(msg.sender, _receiver, _underlyingAddress, _amount);
    }

}
