/**
 * Prices and free allowances used for usage estimates. Checked against the official pricing
 * pages on 2026-10-16 (see docs/RESEARCH.md). Google can change these; update them here only.
 */

/** Free build-minutes per billing account per month (default pool, e2-standard-2). */
export const FREE_BUILD_MINUTES = 2500;

/** USD per build-minute for e2-standard-2 in the default pool. Billed per second. */
export const BUILD_PRICE_PER_MINUTE_USD = 0.006;

/** Artifact Registry storage free per billing account per month: 0.5 GiB. */
export const AR_FREE_BYTES = 0.5 * 1024 ** 3;

/** USD per GiB-month of Artifact Registry storage above the free allowance. */
export const AR_PRICE_PER_GIB_MONTH_USD = 0.1;

/** Where the real bill lives. */
export const BILLING_URL = 'https://console.cloud.google.com/billing';
