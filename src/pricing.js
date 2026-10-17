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

// dockeriser ci: spot E2 VMs. From the Cloud Billing catalogue (Compute Engine, service
// 6F81-5844-456A), Toronto (northamerica-northeast2), effective 2026-10-16. Other regions are
// estimated with these prices.

/** USD per vCPU-hour of a spot E2 VM. */
export const CI_SPOT_E2_CORE_HOUR_USD = 0.005;

/** USD per GiB-hour of spot E2 VM memory. */
export const CI_SPOT_E2_RAM_GIB_HOUR_USD = 0.000668;

/** USD per GiB-month of balanced persistent disk (the boot disk), billed per second. */
export const CI_PD_BALANCED_GIB_MONTH_USD = 0.11;

/** USD per hour for the external IPv4 address of a spot VM. */
export const CI_SPOT_IP_HOUR_USD = 0.0025;

/**
 * The CI ceiling: past this much estimated spend in a calendar month, `dockeriser ci` turns itself
 * off for everyone until the month ends. Equal to the budget alert setup creates ($5), about 160
 * full appraiseme gates. Hard-coded on purpose: there is no flag or config key that raises it.
 */
export const CI_MONTHLY_CAP_USD = 5;

/** From this day of the month, a pace that projects past the cap by month end also turns CI off. */
export const CI_PACE_FROM_DAY = 7;

/** Any day: once this much is spent, a pace past CI_RUNAWAY_FACTOR x the cap turns CI off (a loop, not use). */
export const CI_RUNAWAY_MIN_SPENT_USD = 1;
export const CI_RUNAWAY_FACTOR = 3;
