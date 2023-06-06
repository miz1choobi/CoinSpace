import axios from 'axios';
import crypto from 'crypto';
import createError from 'http-errors';
import Big from 'big.js';
import cryptoDB from '@coinspace/crypto-db';

const privateKey = crypto.createPrivateKey({
  key: process.env.CHANGELLY_API_SECRET,
  format: 'der',
  type: 'pkcs8',
  encoding: 'hex',
});

const publicKey = crypto.createPublicKey(privateKey).export({
  type: 'pkcs1',
  format: 'der',
});

const CHANGELLY_API_KEY = crypto.createHash('sha256').update(publicKey).digest('base64');
const API_URL = 'https://api.changelly.com/v2';

async function request(method, params) {
  const message = {
    jsonrpc: '2.0',
    id: 'cs',
    method,
    params,
  };
  const signature = crypto.sign('sha256', Buffer.from(JSON.stringify(message)), {
    key: privateKey,
    type: 'pkcs8',
    format: 'der',
  }).toString('base64');

  const response = await axios({
    method: 'post',
    url: API_URL,
    headers: {
      'X-Api-Key': CHANGELLY_API_KEY,
      'X-Api-Signature': signature,
    },
    data: message,
  });
  return response && response.data && response.data.result;
}

function isGreater3hours(tx) {
  return (new Date() - new Date(Math.round(tx.createdAt / 1000))) > 3 * 60 * 60 * 1000;
}

function getCrypto(id) {
  const item = cryptoDB.find((item) => item._id === id);
  if (!(item && item.changelly && item.changelly.ticker)) {
    throw createError(400, `'${id}' crypto not supported`);
  }
  return item;
}

function normalizeNumber(n, decimals) {
  return Big(n).round(decimals ?? 8).toFixed();
}

async function getPairsParams(from, to) {
  const fromCrypto = getCrypto(from);
  const toCrypto = getCrypto(to);
  const data = await request('getPairsParams', [{
    from: fromCrypto.changelly.ticker,
    to: toCrypto.changelly.ticker,
  }]);
  if (!data) {
    throw createError(400, 'Exchange is currently unavailable for this pair');
  }
  return {
    minAmount: normalizeNumber(data[0].minAmountFloat, fromCrypto.decimals),
    maxAmount: normalizeNumber(data[0].maxAmountFloat, fromCrypto.decimals),
  };
}

async function estimate(from, to, value) {
  const fromCrypto = getCrypto(from);
  const toCrypto = getCrypto(to);
  const data = await request('getExchangeAmount', [{
    from: fromCrypto.changelly.ticker,
    to: toCrypto.changelly.ticker,
    amountFrom: value,
  }]);
  if (!data) {
    return {
      rate: '0',
      result: '0',
    };
  }
  const networkFee = Big(data[0].networkFee);
  const amount = Big(data[0].amountFrom);
  const result = Big(data[0].amountTo).minus(networkFee);
  return {
    rate: amount.eq(0) ? '0' : normalizeNumber(result.div(amount), toCrypto.decimals),
    result: normalizeNumber(result, toCrypto.decimals),
  };
}

async function validateAddress(address, id) {
  const item = getCrypto(id);
  const data = await request('validateAddress', {
    address,
    currency: item.changelly.ticker,
  });
  return {
    isValid: data ? data.result : false,
  };
}

async function createTransaction(from, to, amountFrom, address, refundAddress) {
  const fromCrypto = getCrypto(from);
  const toCrypto = getCrypto(to);
  const data = await request('createTransaction', {
    from: fromCrypto.changelly.ticker,
    to: toCrypto.changelly.ticker,
    amountFrom,
    address,
    refundAddress,
  });
  if (!data) {
    throw createError(500, 'Transaction not created');
  }
  return {
    id: data.id,
    depositAmount: normalizeNumber(data.amountExpectedFrom),
    depositAddress: data.payinAddress,
    extraId: data.payinExtraId,
  };
}

async function getTransaction(id) {
  const txs = await request('getTransactions', {
    id,
  });
  const tx = txs && txs[0];
  if (!tx) {
    throw createError(404, 'Transaction not found');
  }
  let { status } = tx;
  if (status === 'waiting' && isGreater3hours(tx)) {
    status = 'overdue';
  }
  return {
    amountTo: tx.amountTo,
    status,
    ...(status === 'finished' ? {
      payoutHashLink: tx.payoutHashLink,
      payoutHash: tx.payoutHash,
    } : {}),
  };
}

async function getTransactions(id, currency, address, limit, offset) {
  const txs = await request('getTransactions', {
    id,
    currency,
    address,
    limit,
    offset,
  });

  return txs.map((tx) => {
    let { status } = tx;
    if (status === 'waiting' && isGreater3hours(tx)) {
      status = 'overdue';
    }
    return {
      id: tx.id,
      trackUrl: tx.trackUrl,
      status,
      amountTo: tx.amountTo || '0',
      amountExpectedTo: tx.amountExpectedTo || '0',
      amountFrom: tx.amountFrom || '0',
      amountExpectedFrom: tx.amountExpectedFrom || '0',
      currencyFrom: tx.currencyFrom,
      currencyTo: tx.currencyTo,
      createdAt: new Date(Math.round(tx.createdAt / 1000)).toISOString(),
      payinAddress: tx.payinAddress,
      payinHash: tx.payinHash || undefined,
      payoutAddress: tx.payoutAddress,
      payoutHashLink: tx.payoutHashLink || undefined,
      payoutHash: tx.payoutHash || undefined,
      refundAddress: tx.refundAddress || undefined,
    };
  });
}

export default {
  getPairsParams,
  estimate,
  validateAddress,
  createTransaction,
  getTransaction,
  getTransactions,
};
