import assert from "node:assert/strict";
import test from "node:test";
import { mergeDailyTransactionCounts, reconstructCumulativeTransactions } from "./transactionSeries.js";

function utcDate(daysAgo) {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() - daysAgo);
  return date.toISOString().slice(0, 10);
}

test("merges Blockscout transactions_count data into a rising cumulative series", () => {
  const daily = mergeDailyTransactionCounts([
    { date: utcDate(1), transactions_count: 7 },
    { date: utcDate(2), transactions_count: 5 },
  ], {});
  const series = reconstructCumulativeTransactions(daily, 100);

  assert.deepEqual(daily, [
    { date: utcDate(1), transaction_count: 7 },
    { date: utcDate(2), transaction_count: 5 },
  ]);
  assert.deepEqual(series, [
    { label: utcDate(2), value: 93 },
    { label: utcDate(1), value: 100 },
  ]);
});

test("falls back to the local count when a Blockscout count is invalid", () => {
  const date = utcDate(1);
  const daily = mergeDailyTransactionCounts([
    { date, transactions_count: "not-a-count" },
  ], {
    [date]: { txCount: 9 },
  });

  assert.deepEqual(daily, [{ date, transaction_count: 9 }]);
});
