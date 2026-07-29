const FORMATTERS = new Map<string, Intl.NumberFormat>();

/**
 * Format an integer minor-unit amount for display.
 */
export function formatMoney(minorUnits: number, currency = "EUR"): string {
    let formatter = FORMATTERS.get(currency);

    if (!formatter) {
        formatter = new Intl.NumberFormat("en-IE", { style: "currency", currency });
        FORMATTERS.set(currency, formatter);
    }

    return formatter.format(minorUnits / 100);
}

export function formatDate(iso: string): string {
    return new Intl.DateTimeFormat("en-IE", { dateStyle: "medium" }).format(new Date(iso));
}
