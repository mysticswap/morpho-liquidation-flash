# Morpho Flash Liquidator

This project is an advanced Liquidator contract, built on top of Morpho Compound Mainnet and Morpho AaveV2 Mainnet.

This is not a competitive liquidation bot, but a liquidation bot that can be used to liquidate a large amount of collateral in a single transaction,
without any funds needed other than gas fees.

You can use it at your own risks, or use it as a baseline and improve it.

## Flash Mint liquidator

The first version of the Liquidator contract uses a MakerDAO Flash loan of DAI, a supply/borrow on Compound or Aave, and a swap on Uniswap V3.

## Development

Installing dependencies:

```bash
nvm install && nvm use && yarn
```

Building contracts:

```shell
yarn compile
```

Running tests:

```shell
yarn test
```

## Deployment

To deploy liquidator contracts, you must set the environements variables in a `.env` file:

- `PRIVATE_KEY`: the private key of the account that will deploy the contracts.
- `PROTOCOLS`: The underlying protocols to use for the liquidator (comma separated list, aave and/or compound).
- `ALCHEMY_KEY`: the Alchemy key to connect to the Ethereum network.

And then run:

```shell
yarn deploy:contracts
```

## Liquidation bot

### Locally

To run a liquidation check, you just have to set the right environment variables, extracted from the `.env.example` file:

- `PRIVATE_KEY`: the private key of the account that will be used to send the transactions. If not provided, you'll run the bot in read only mode.
  Your address must be an allowed liquidator of the flash liquidator contract. The two example addresses in the `.env.example` file are the ones of Morpho Labs.
- `ALCHEMY_KEY`: the Alchemy key to connect to the Ethereum network.
- `LIQUIDATOR_ADDRESSES`: a comma separated list of the liquidator contract addresses to use. Only used if you use the `--flash` option.
- `PROFITABLE_THRESHOLD`: the liquidation threshold to use (in USD).
- `BATCH_SIZE`: The number of parallel queries sent to the Ethereum network.
- `PROTOCOLS`: The underlying protocols to use (comma separated list).
- `DELAY`: The delay between two liquidations check. If not provided, the bot will run only once.

Then, you can just run:

#### EOA Liquidation

```shell
yarn run:bot
```

Without the `--flash` option, the bot will use your wallet to liquidate without using any contract. In this case, you need to have
the funds to liquidate the user. Else, the script will throw an error.

#### Flash Liquidation

```shell
yarn run:bot --flash
```

In order to use flash liquidation, you have to deploy the contracts first, and then set the `LIQUIDATOR_ADDRESSES` environment variable.

### Remarks

The script can throw an error and stop execution in some case, specially if you have a blockchain provider error, if you have not enough
funds to send any transaction, or if you have not enough funds to liquidate the user with EOA mode.

### Remotely

To deploy the liquidation bot on AWS Lambda, you have to use the AWS SAM cli and Docker, and then running

```shell
sam build && sam deploy --guided
```

You can customize the deployment by editing the `template.yaml` file.

TODO:

- deploy subgraph on plume
- test on aave v3 on polygon
- test aave v3 on plume
- cleanup and call for each market
