import { Currency } from "@renex/react-components";
import {
    btcAddressToHex, Chain, ShiftedInResponse, ShiftedOutResponse, strip0x, UTXO,
} from "@ren-project/ren";
import BigNumber from "bignumber.js";
import { List, Map, OrderedMap } from "immutable";
import { Container } from "unstated";
import { TransactionReceipt } from "web3-core";

import {
    getRenExAdapterAddress, getTokenAddress, syncGetRenExAdapterAddress,
} from "../lib/contractAddresses";
import { Commitment, DexSDK, OrderInputs, ReserveBalances } from "../lib/dexSDK";
import { _catchBackgroundErr_, _catchInteractionErr_ } from "../lib/errors";
import { estimatePrice } from "../lib/estimatePrice";
import { getWeb3 } from "../lib/getWeb3";
import { history } from "../lib/history";
import { getMarket, getTokenPricesInCurrencies } from "../lib/market";
import { isERC20, isEthereumBased, MarketPair, Token, Tokens } from "./generalTypes";

export interface Tx {
    hash: string;
    chain: Chain;
}

const BitcoinTx = (hash: string) => ({ hash, chain: Chain.Bitcoin });
// const ZCashTx = (hash: string) => ({ hash, chain: Chain.ZCash });
const EthereumTx = (hash: string) => ({ hash, chain: Chain.Ethereum });

export interface HistoryEvent {
    time: number; // Seconds since Unix epoch
    // inTx: Tx;
    outTx: Tx;
    receivedAmount: string;
    orderInputs: OrderInputs;
    complete: boolean;
}

const initialOrder: OrderInputs = {
    srcToken: Token.BTC,
    dstToken: Token.DAI,
    srcAmount: "0.000225",
    dstAmount: "0",
};

const initialState = {
    preferredCurrency: Currency.USD,

    address: null as string | null,
    tokenPrices: Map<Token, Map<Currency, number>>(),
    accountBalances: Map<Token, BigNumber>(),
    balanceReserves: Map<MarketPair, ReserveBalances>(),
    dexSDK: null as null | DexSDK,

    orderInputs: initialOrder,
    confirmedOrderInputs: null as null | OrderInputs,

    pendingTXs: OrderedMap<string, number>(),

    confirmedTrade: false,
    submitting: false,
    toAddress: null as string | null,
    refundAddress: null as string | null,
    commitment: null as Commitment | null,
    depositAddress: null as string | null,
    depositAddressToken: null as Token | null,
    utxos: null as List<UTXO> | null,
    erc20Approved: false,
    signature: null as ShiftedInResponse | ShiftedOutResponse | null,
    inTx: null as Tx | null,
    outTx: null as Tx | null,
    receivedAmount: null as BigNumber | null,
    receivedAmountHex: null as string | null,
};

export class AppContainer extends Container<typeof initialState> {
    public state = initialState;

    public connect = async (): Promise<void> => {

        const web3 = await getWeb3();
        const networkID = await web3.eth.net.getId();

        const dexSDK = new DexSDK(web3, networkID);
        await this.setState({ dexSDK });

        const addresses = await web3.eth.getAccounts();
        await this.setState({ address: addresses.length > 0 ? addresses[0] : null });
        await this.updateAccountBalances();
    }

    public clearAddress = async (): Promise<void> => {
        await this.setState({ address: null });
    }

    // Token prices ////////////////////////////////////////////////////////////

    public setCurrency = async (preferredCurrency: Currency) => {
        await this.setState({ preferredCurrency });
    }

    public updateTokenPrices = async (): Promise<void> => {
        const tokenPrices = await getTokenPricesInCurrencies();
        await this.setState({ tokenPrices });
    }

    public updateBalanceReserves = async (): Promise<void> => {
        const { balanceReserves, dexSDK } = this.state;
        if (!dexSDK) { return; }

        let newBalanceReserves = balanceReserves;
        // const marketPairs = [MarketPair.DAI_BTC, MarketPair.ETH_BTC, MarketPair.REN_BTC, MarketPair.ZEC_BTC];
        const marketPairs = [MarketPair.DAI_BTC];
        const res = await dexSDK.getReserveBalance(marketPairs); // Promise<Array<Map<Token, BigNumber>>> => {
        marketPairs.forEach((value, index) => {
            newBalanceReserves = newBalanceReserves.set(value, res[index]);
        });
        await this.setState({ balanceReserves: newBalanceReserves });
        await this.updateReceiveValue();
    }

    // Swap inputs /////////////////////////////////////////////////////////////

    public updateSrcToken = async (srcToken: Token): Promise<void> => {
        await this.setState({ orderInputs: { ...this.state.orderInputs, srcToken } });
        await this.updateHistory();
        await this.updateReceiveValue();
    }

    public updateDstToken = async (dstToken: Token): Promise<void> => {
        await this.setState({ orderInputs: { ...this.state.orderInputs, dstToken } });
        await this.updateHistory();
        await this.updateReceiveValue();
    }

    public updateSrcAmount = async (srcAmount: string): Promise<void> => {
        await this.setState({ orderInputs: { ...this.state.orderInputs, srcAmount } });
        await this.updateReceiveValue();
    }

    public flipSendReceive = async (): Promise<void> => {
        const { orderInputs: { srcToken, dstToken } } = this.state;
        await this.updateBothTokens(dstToken, srcToken);
    }

    public updateBothTokens = async (srcToken: Token, dstToken: Token): Promise<void> => {
        await this.setState({ orderInputs: { ...this.state.orderInputs, srcToken, dstToken } });
        await this.updateHistory();
        await this.updateReceiveValue();
    }

    // Opening order ///////////////////////////////////////////////////////////

    public onConfirmedTrade = () => {
        this.setState({ confirmedTrade: true }).catch(_catchBackgroundErr_);
        if (this.state.confirmedOrderInputs && isERC20(this.state.confirmedOrderInputs.srcToken)) {
            this.getAllowance().catch(_catchBackgroundErr_);
        }
    }

    public updateToAddress = async (toAddress: string) => {
        await this.setState({ toAddress });
    }
    public updateRefundAddress = async (refundAddress: string) => {
        await this.setState({ refundAddress });
    }

    public waitForDeposits = async () => {
        const { dexSDK } = this.state;
        if (!dexSDK) { return; }

        await dexSDK.waitForDeposit();
    }

    public updateCommitment = async () => {
        const { orderInputs: order, dexSDK, toAddress, refundAddress } = this.state;
        if (!dexSDK) { return; }

        const srcTokenDetails = Tokens.get(order.srcToken);
        if (!toAddress || !refundAddress || !srcTokenDetails) {
            throw new Error(`Required info is undefined (${toAddress}, ${refundAddress}, ${srcTokenDetails})`);
        }
        if (!dexSDK.web3) {
            throw new Error("Not ready yet...");
        }
        const blockNumber = await dexSDK.web3.eth.getBlockNumber();
        let hexRefundAddress = refundAddress;
        if (order.srcToken === Token.BTC) {
            hexRefundAddress = btcAddressToHex(refundAddress);
        }
        let hexToAddress = toAddress;
        if (order.dstToken === Token.BTC) {
            hexToAddress = btcAddressToHex(toAddress);
        }
        const commitment: Commitment = {
            srcToken: await getTokenAddress(order.srcToken),
            dstToken: await getTokenAddress(order.dstToken),
            minDestinationAmount: new BigNumber(0),
            srcAmount: new BigNumber(order.srcAmount).multipliedBy(new BigNumber(10).exponentiatedBy(srcTokenDetails.decimals)),
            toAddress: hexToAddress,
            refundBlockNumber: blockNumber + 360, // 360 blocks (assuming 0.1bps, equals 1 hour)
            refundAddress: hexRefundAddress,
            orderInputs: order,
        };
        if (isEthereumBased(order.srcToken)) {
            await this.setState({ commitment });
        } else {
            const depositAddress = await dexSDK.generateAddress(order.srcToken, commitment);
            const depositAddressToken = order.srcToken;
            await this.setState({ commitment, depositAddress, depositAddressToken });
        }
    }

    public submitDeposit = async () => {
        const { dexSDK } = this.state;
        if (!dexSDK) {
            throw new Error(`Invalid values required to submit deposit`);
        }
        await dexSDK.submitDeposit();
    }

    public checkBurnStatus = async () => {
        const { dexSDK, inTx, commitment } = this.state;
        if (!dexSDK || !inTx || !commitment) {
            throw new Error(`Invalid values required to submit deposit`);
        }
        const response = await dexSDK.checkBurnStatus(commitment.orderInputs.dstToken, inTx.hash);
        const receivedAmount = new BigNumber(response.amount).dividedBy(new BigNumber(10).exponentiatedBy(8));
        await this.setState({ receivedAmount, outTx: BitcoinTx(response.to) });
    }

    public submitBurn = async () => {
        await this.updateCommitment();
        const { address, dexSDK, commitment } = this.state;
        if (!dexSDK || !address || !commitment) {
            throw new Error(`Invalid values required for swap (dexSDK: ${!!dexSDK}, address: ${!!address}, commitment: ${!!commitment})`);
        }

        const promiEvent = dexSDK.submitBurn(address, commitment);
        const transactionHash = await new Promise<string>((resolve, reject) => promiEvent.on("transactionHash", resolve).catch(reject));

        const receivedAmount = await new Promise<BigNumber>((resolve, reject) => (promiEvent.once as any)("confirmation", async (confirmations: number, receipt: TransactionReceipt) => {
            // Loop through logs to find burn log
            for (const log of receipt.logs) {
                if (
                    log.address.toLowerCase() === (await getTokenAddress(commitment.orderInputs.dstToken)).toLowerCase() &&
                    log.topics[0] === "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef".toLowerCase() &&
                    log.topics[1] === `0x000000000000000000000000${strip0x(await getRenExAdapterAddress())}`.toLowerCase() &&
                    log.topics[2] === "0x0000000000000000000000000000000000000000000000000000000000000000".toLowerCase()
                ) {
                    const dstTokenDetails = Tokens.get(commitment.orderInputs.dstToken);
                    const decimals = dstTokenDetails ? dstTokenDetails.decimals : 8;
                    const receivedAmountHex = parseInt(log.data, 16).toString(16);
                    const rcv = new BigNumber(log.data, 16).dividedBy(new BigNumber(10).exponentiatedBy(decimals));
                    this.setState({ receivedAmountHex }).catch(_catchInteractionErr_);
                    resolve(rcv);
                }
            }
            reject();
        }).catch(reject));

        await this.setState({ receivedAmount, inTx: EthereumTx(transactionHash) });
    }

    public submitSwap = async () => {
        await this.updateCommitment();
        const { address, dexSDK, commitment, signature } = this.state;
        if (!dexSDK || !address || !commitment) {
            throw new Error(`Invalid values required for swap (dexSDK: ${!!dexSDK}, address: ${!!address}, commitment: ${!!commitment})`);
        }

        const promiEvent = dexSDK.submitSwap(address, commitment, await getRenExAdapterAddress(), signature);
        const transactionHash = await new Promise<string>((resolve, reject) => promiEvent.on("transactionHash", resolve).catch(reject));

        if (isEthereumBased(commitment.orderInputs.dstToken)) {
            await this.setState({ pendingTXs: this.state.pendingTXs.set(transactionHash, 0) });
        }

        const receivedAmount = await new Promise<BigNumber>((resolve, reject) => (promiEvent.once as any)("confirmation", async (confirmations: number, receipt: TransactionReceipt) => {
            if (isEthereumBased(commitment.orderInputs.dstToken)) {
                this.setState({ pendingTXs: this.state.pendingTXs.remove(transactionHash) }).catch(_catchInteractionErr_);

                // Loop through logs to find burn log
                for (const log of receipt.logs) {
                    if (
                        log.address.toLowerCase() === (await getTokenAddress(commitment.orderInputs.dstToken)).toLowerCase() &&
                        log.topics[0] === "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef".toLowerCase() &&
                        // log.topics[1] === `0x000000000000000000000000${strip0x(reserve_address)}`.toLowerCase() &&
                        log.topics[2] === `0x000000000000000000000000${strip0x(commitment.toAddress)}`.toLowerCase()
                    ) {
                        const dstTokenDetails = Tokens.get(commitment.orderInputs.dstToken);
                        const decimals = dstTokenDetails ? dstTokenDetails.decimals : 8;
                        const rcv = new BigNumber(log.data, 16).dividedBy(new BigNumber(10).exponentiatedBy(decimals));
                        resolve(rcv);
                    }
                }
                reject();
            } else {
                // Loop through logs to find burn log
                for (const log of receipt.logs) {
                    if (
                        log.address.toLowerCase() === (await getTokenAddress(commitment.orderInputs.dstToken)).toLowerCase() &&
                        log.topics[0] === "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef".toLowerCase() &&
                        log.topics[1] === `0x000000000000000000000000${strip0x(await getRenExAdapterAddress())}`.toLowerCase() &&
                        log.topics[2] === "0x0000000000000000000000000000000000000000000000000000000000000000".toLowerCase()
                    ) {
                        const dstTokenDetails = Tokens.get(commitment.orderInputs.dstToken);
                        const decimals = dstTokenDetails ? dstTokenDetails.decimals : 8;
                        const receivedAmountHex = parseInt(log.data, 16).toString(16);
                        const rcv = new BigNumber(log.data, 16).dividedBy(new BigNumber(10).exponentiatedBy(decimals));
                        this.setState({ receivedAmountHex }).catch(_catchInteractionErr_);
                        resolve(rcv);
                    }
                }
                reject();
            }
        }).catch(reject));

        if (isEthereumBased(commitment.orderInputs.dstToken)) {
            await this.setState({ receivedAmount, outTx: EthereumTx(transactionHash) });
        } else {
            await this.setState({ receivedAmount, inTx: EthereumTx(transactionHash) });
        }
    }

    public getHistoryEvent = async () => {
        const { inTx, outTx, commitment, receivedAmount } = this.state;
        if (!commitment || !outTx || !receivedAmount) {
            throw new Error(`Invalid values passed to getHistoryEvent`);
        }
        const historyItem: HistoryEvent = {
            // inTx,
            outTx,
            receivedAmount: receivedAmount.toFixed(),
            orderInputs: commitment.orderInputs,
            time: Date.now() / 1000,
            complete: false,
        };

        await this.resetTrade();
        return historyItem;
    }

    public setSubmitting = async (submitting: boolean) => {
        await this.setState({
            submitting,
            confirmedOrderInputs: { ...this.state.orderInputs },
        });
    }

    public resetTrade = async () => {
        await this.setState({
            confirmedTrade: false,
            submitting: false,
            toAddress: null,
            refundAddress: null,
            commitment: null,
            depositAddress: null,
            depositAddressToken: null,
            utxos: null,
            signature: null,
            erc20Approved: false,
            inTx: null,
            outTx: null,
            receivedAmount: null,
            receivedAmountHex: null,
        });
    }

    public sufficientBalance = (): boolean => {
        const { orderInputs: { srcToken, srcAmount }, accountBalances } = this.state;
        // We can't know the balance if it's not an Ethereum token
        if (!isEthereumBased(srcToken)) {
            return true;
        }

        // Fetch information about srcToken
        const srcTokenDetails = Tokens.get(srcToken);
        if (!srcTokenDetails) {
            return false;
        }
        const srcAmountBN = new BigNumber(srcAmount).multipliedBy(new BigNumber(10).exponentiatedBy(srcTokenDetails.decimals));
        const balance = accountBalances.get(srcToken) || new BigNumber(0);
        if (srcAmountBN.isNaN()) {
            return true;
        }
        return srcAmountBN.lte(balance);
    }

    // Check the the volume isn't below the minimum required volume
    public validVolume = (): boolean => {
        const { orderInputs: { srcToken, srcAmount, dstToken, dstAmount } } = this.state;
        if (srcToken === Token.BTC || srcToken === Token.ZEC) {
            if (new BigNumber(srcAmount).isLessThan(0.00015)) {
                return false;
            }
        }
        if (dstToken === Token.BTC || dstToken === Token.ZEC) {
            if (new BigNumber(dstAmount).isLessThan(0.00015)) {
                return false;
            }
        }
        return true;
    }

    public updateAccountBalances = async (): Promise<void> => {
        const { dexSDK, address } = this.state;
        if (!dexSDK || !address) {
            return;
        }
        let accountBalances = this.state.accountBalances;
        const ethTokens = [Token.ETH, Token.DAI]; // , Token.REN];
        const promises = ethTokens.map(token => dexSDK.fetchEthereumTokenBalance(token, address));
        const balances = await Promise.all(promises);
        balances.forEach((bal, index) => {
            accountBalances = accountBalances.set(ethTokens[index], bal);
        });

        await this.setState({ accountBalances });
    }

    public getAllowance = async () => {
        const { orderInputs: { srcToken, srcAmount }, dexSDK, address } = this.state;
        const srcTokenDetails = Tokens.get(srcToken);
        if (!dexSDK || !address || !srcTokenDetails) {
            this.setState({ erc20Approved: false }).catch(_catchBackgroundErr_);
            return;
        }
        const srcAmountBN = new BigNumber(srcAmount).multipliedBy(new BigNumber(10).exponentiatedBy(srcTokenDetails.decimals));
        const allowance = await dexSDK.getTokenAllowance(srcToken, address);
        this.setState({ erc20Approved: allowance.gte(srcAmountBN) }).catch(_catchBackgroundErr_);
    }

    public setAllowance = async () => {
        const { orderInputs: { srcToken, srcAmount }, dexSDK, address } = this.state;
        const srcTokenDetails = Tokens.get(srcToken);
        if (!dexSDK || !address || !srcTokenDetails) {
            this.setState({ erc20Approved: false }).catch(_catchBackgroundErr_);
            return;
        }
        const srcAmountBN = new BigNumber(srcAmount).multipliedBy(new BigNumber(10).exponentiatedBy(srcTokenDetails.decimals));
        const allowance = await dexSDK.setTokenAllowance(srcAmountBN, srcToken, address);
        this.setState({ erc20Approved: allowance.gte(srcAmountBN) }).catch(_catchBackgroundErr_);
    }

    private readonly updateReceiveValue = async (): Promise<void> => {
        const { orderInputs: { srcToken, dstToken, srcAmount } } = this.state;
        const market = getMarket(srcToken, dstToken);
        if (market) {
            const reserves = this.state.balanceReserves.get(market);

            const dstAmount = await estimatePrice(srcToken, dstToken, srcAmount, reserves);
            await this.setState({ orderInputs: { ...this.state.orderInputs, dstAmount: dstAmount.toFixed() } });
        }
    }

    private readonly updateHistory = async (): Promise<void> => {
        const { orderInputs: { srcToken, dstToken } } = this.state;
        history.replace(`/?send=${srcToken}&receive=${dstToken}`);
    }
}
