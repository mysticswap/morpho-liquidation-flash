import { BigNumber, providers } from "ethers";
import { Logger } from "./interfaces/logger";
import { IAaveFetcher, IFetcher } from "./interfaces/IFetcher";
import { formatUnits, parseUnits } from "ethers/lib/utils";
import stablecoins from "./constant/stablecoins";
import { ethers } from "hardhat";
import config from "../config";
import underlyings from "./constant/underlyings";
import { getPoolData, UniswapPool } from "./uniswap/pools";
import { IMorphoAdapter } from "./morpho/Morpho.interface";
import {
  ILiquidationHandler,
  LiquidationParams,
  UserLiquidationParams,
} from "./LiquidationHandler/LiquidationHandler.interface";
import { PercentMath } from "@morpho-labs/ethers-utils/lib/maths";

export interface LiquidationBotSettings {
  profitableThresholdUSD: BigNumber;
  batchSize: number;
}
const defaultSettings: LiquidationBotSettings = {
  profitableThresholdUSD: parseUnits("1"),
  batchSize: 15,
};

export default class LiquidationBot {
  static W_ETH =
    process.env.WETH ||
    "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2".toLowerCase();
  markets: string[] = [];
  static readonly HF_THRESHOLD = parseUnits("1");
  settings: LiquidationBotSettings = defaultSettings;
  constructor(
    public readonly logger: Logger,
    public readonly fetcher: IFetcher,
    public readonly provider: providers.Provider,
    public readonly liquidationHandler: ILiquidationHandler,
    public readonly adapter: IMorphoAdapter,
    settings: Partial<LiquidationBotSettings> = {}
  ) {
    this.settings = { ...defaultSettings, ...settings };
  }

  async computeLiquidableUsers() {
    let lastId = "";
    let hasMore = true;
    let liquidableUsers: { address: string; hf: BigNumber }[] = [];
    while (hasMore) {
      let users: string[];
      ({ hasMore, lastId, users } = await this.fetcher.fetchUsers(lastId));
      this.logger.log(`${users.length} users fetched`);
      const newLiquidatableUsers = await Promise.all(
        users.map(async (userAddress) => ({
          address: userAddress,
          hf: await this.adapter.getUserHealthFactor(userAddress),
        }))
      ).then((healthFactors) =>
        healthFactors.filter((userHf) => {
          if (
            userHf.hf.lt(parseUnits("0.65")) &&
            userHf.hf.gt(parseUnits("0.01"))
          )
            this.logger.log(
              `User ${userHf.address} has a low HF (${formatUnits(userHf.hf)})`
            );
          return userHf.hf.lt(LiquidationBot.HF_THRESHOLD);
        })
      );
      liquidableUsers = [...liquidableUsers, ...newLiquidatableUsers];
      this.delay(100);
      // hasMore = false;
    }
    console.log(liquidableUsers.length);
    return liquidableUsers;
  }

  async computeMarkets() {
    // let lastId = "";
    // let hasMore = true;
    let markets = await this.fetcher.fetchMarkets?.();
    this.logger.log(`${markets?.markets?.length} markets fetched`);

    const activeMarkets = markets?.markets as string[];

    return activeMarkets;
  }

  delay(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async liquidate(
    poolTokenBorrowed: string,
    poolTokenCollateral: string,
    user: string,
    amount: BigNumber,
    swapPath: string
  ) {
    const liquidationParams: LiquidationParams = {
      poolTokenBorrowed,
      poolTokenCollateral,
      underlyingBorrowed: underlyings[poolTokenBorrowed.toLowerCase()],
      user,
      amount,
      swapPath,
    };
    return this.liquidationHandler.handleLiquidation(liquidationParams);
  }

  async getUserLiquidationParams(userAddress: string, markets: string[] = []) {
    // first fetch all user balances

    const balances = await Promise.all(
      markets.map(async (market) => {
        const [
          { totalBalance: totalSupplyBalance },
          { totalBalance: totalBorrowBalance },
        ] = await Promise.all([
          this.adapter.getCurrentSupplyBalanceInOf(market, userAddress),
          this.adapter.getCurrentBorrowBalanceInOf(market, userAddress),
        ]);

        const {
          price,
          balances: [totalSupplyBalanceUSD, totalBorrowBalanceUSD],
        } = await this.adapter.normalize(market, [
          totalSupplyBalance,
          totalBorrowBalance,
        ]);
        const liquidationBonus = await this.adapter.getLiquidationBonus(market);
        return {
          market,
          liquidationBonus,
          totalSupplyBalance,
          totalBorrowBalance,
          price,
          totalSupplyBalanceUSD,
          totalBorrowBalanceUSD,
        };
      })
    );
    const [debtMarket] = balances.sort((a, b) =>
      a.totalBorrowBalanceUSD.gt(b.totalBorrowBalanceUSD) ? -1 : 1
    );
    const [collateralMarket] = balances
      .filter((b) => b.liquidationBonus.gt(0))
      .sort((a, b) =>
        a.totalSupplyBalanceUSD.gt(b.totalSupplyBalanceUSD) ? -1 : 1
      );
    this.logger.table({
      user: userAddress,
      debt: {
        market: debtMarket.market,
        totalBorrowBalanceUSD: formatUnits(debtMarket.totalBorrowBalanceUSD),
        price: formatUnits(debtMarket.price),
        totalSupplyBalanceUSD: formatUnits(debtMarket.totalSupplyBalanceUSD),
      },
      collateral: {
        market: collateralMarket.market,
        totalBorrowBalanceUSD: formatUnits(
          collateralMarket.totalBorrowBalanceUSD
        ),
        price: formatUnits(collateralMarket.price),
        totalSupplyBalanceUSD: formatUnits(
          collateralMarket.totalSupplyBalanceUSD
        ),
      },
    });
    const { toLiquidate, rewardedUSD } =
      await this.adapter.getMaxLiquidationAmount(debtMarket, collateralMarket);
    return {
      collateralMarket,
      debtMarket,
      toLiquidate,
      rewardedUSD,
      userAddress,
    };
  }

  getPath(borrowMarket: string, collateralMarket: string) {
    borrowMarket = borrowMarket.toLowerCase();
    collateralMarket = collateralMarket.toLowerCase();
    if (borrowMarket === collateralMarket) return "0x";
    if (
      [underlyings[borrowMarket], underlyings[collateralMarket]].includes(
        LiquidationBot.W_ETH
      )
    ) {
      // a simple swap with wEth
      return ethers.utils.solidityPack(
        ["address", "uint24", "address"],
        [
          underlyings[borrowMarket],
          config.swapFees.classic,
          underlyings[collateralMarket],
        ]
      );
    }
    if (
      stablecoins.includes(borrowMarket) &&
      stablecoins.includes(collateralMarket)
    )
      return ethers.utils.solidityPack(
        ["address", "uint24", "address"],
        [
          underlyings[borrowMarket],
          config.swapFees.stable,
          underlyings[collateralMarket],
        ]
      );
    return ethers.utils.solidityPack(
      ["address", "uint24", "address", "uint24", "address"],
      [
        underlyings[borrowMarket],
        config.swapFees.exotic,
        LiquidationBot.W_ETH,
        config.swapFees.exotic,
        underlyings[collateralMarket],
      ]
    );
  }

  async isProfitable(market: string, toLiquidate: BigNumber, price: BigNumber) {
    const rewards = await this.adapter.getLiquidationBonus(market);
    const usdAmount = await this.adapter.toUsd(market, toLiquidate, price);
    return PercentMath.percentMul(
      usdAmount,
      rewards.sub(PercentMath.BASE_PERCENT)
    ).gt(this.settings.profitableThresholdUSD);
  }

  async checkPoolLiquidity(borrowMarket: string, collateralMarket: string) {
    borrowMarket = borrowMarket.toLowerCase();
    collateralMarket = collateralMarket.toLowerCase();
    let pools: UniswapPool[][] = [];
    if (
      stablecoins.includes(borrowMarket) &&
      stablecoins.includes(collateralMarket)
    ) {
      const data = await getPoolData(
        underlyings[borrowMarket],
        underlyings[collateralMarket]
      );
      pools.push(data);
    } else if (
      [underlyings[borrowMarket], underlyings[collateralMarket]].includes(
        LiquidationBot.W_ETH
      )
    ) {
      const data = await getPoolData(
        underlyings[borrowMarket],
        underlyings[collateralMarket]
      );
      pools.push(data);
    } else {
      const newPools = await Promise.all([
        getPoolData(underlyings[borrowMarket], LiquidationBot.W_ETH),
        getPoolData(underlyings[collateralMarket], LiquidationBot.W_ETH),
      ]);
      pools = [...pools, ...newPools];
    }
    console.log(JSON.stringify(pools, null, 4));
    return pools;
  }

  // async amountAndPathsForMultipleLiquidations(
  //   borrowMarket: string,
  //   collateralMarket: string
  // ) {
  //   const borrowUnderlying = underlyings[borrowMarket.toLowerCase()];
  //   const collateralUnderlying = underlyings[collateralMarket.toLowerCase()];
  //   const pools = await this.checkPoolLiquidity(borrowMarket, collateralMarket);
  //   console.log(pools);
  //   if (pools.length === 1) {
  //     // stable/stable or stable/eth swap
  //     const [oneSwapPools] = pools;
  //   }
  // }

  async run() {
    const users = await this.computeLiquidableUsers();
    this.logger.log(`Found ${users.length} users liquidatable`);
    // use the batch size to limit the number of users to liquidate
    const toLiquidate: UserLiquidationParams[] = [];
    const markets = await this.computeMarkets();
    for (let i = 0; i < users.length; i += this.settings.batchSize) {
      const liquidationsParams = await Promise.all(
        users
          .slice(i, Math.min(i + this.settings.batchSize, users.length))
          .map((u) => this.getUserLiquidationParams(u.address, markets))
      );
      // console.log({ liquidationsParams });

      const batchToLiquidate = (
        await Promise.all(
          liquidationsParams.map(async (user) => {
            if (
              await this.isProfitable(
                user.debtMarket.market,
                user.toLiquidate,
                user.debtMarket.price
              )
            )
              return user;
            return null;
          })
        )
      ).filter(Boolean) as UserLiquidationParams[];
      toLiquidate.push(...batchToLiquidate);
    }

    if (toLiquidate.length > 0) {
      this.logger.log(`${toLiquidate.length} users to liquidate`);
      for (const userToLiquidate of toLiquidate) {
        const swapPath = this.getPath(
          userToLiquidate!.debtMarket.market,
          userToLiquidate!.collateralMarket.market
        );
        // console.log(swapPath);
        const liquidateParams: LiquidationParams = {
          poolTokenBorrowed: userToLiquidate!.debtMarket.market,
          poolTokenCollateral: userToLiquidate!.collateralMarket.market,
          underlyingBorrowed: underlyings[userToLiquidate!.debtMarket.market],
          user: userToLiquidate!.userAddress,
          amount: userToLiquidate!.toLiquidate,
          swapPath,
        };
        // console.log(liquidateParams);
        console.log("here");
        await this.liquidationHandler.handleLiquidation(liquidateParams);
        console.log("done");
      }
    }
  }

  logError(error: object) {
    console.error(error);
    this.logger.log(error);
  }
}
