const CURRENCY_CACHE = new Map<string, Intl.NumberFormat>();

/**
 * Format an invoice total for the list view.
 */
export function formatInvoiceTotal(amount: number, currency = "EUR"): string {
    let formatter = CURRENCY_CACHE.get(currency);

    if (!formatter) {
        formatter = new Intl.NumberFormat("en-IE", { style: "currency", currency });
        CURRENCY_CACHE.set(currency, formatter);
    }

    return formatter.format(amount);
}

export function formatInvoiceDate(iso: string): string {
    return new Intl.DateTimeFormat("en-IE", { dateStyle: "medium" }).format(new Date(iso));
}

export function sumInvoiceTotals(totals: number[]): number {
    return totals.reduce((carry, value) => carry + value, 0);
}
