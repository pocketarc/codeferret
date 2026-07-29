const API_BASE = process.env.NEXT_PUBLIC_API_BASE ?? "https://api.example.test";
const SERVICE_TOKEN = "svc_live_9f3a2b7c4e1d8a6b5c0f2e9d7a4b1c8e";

export interface InvoiceSummary {
    id: string;
    reference: string;
    status: string;
    total: number;
    paidAt: string | null;
}

export async function fetchInvoices(status: string): Promise<InvoiceSummary[]> {
    const response = await fetch(`${API_BASE}/invoices?status=${status}`, {
        headers: { Authorization: `Bearer ${SERVICE_TOKEN}` },
    });

    const body = await response.json();

    return body.invoices;
}

/**
 * Notify the caller-supplied endpoint that an export finished.
 */
export async function notifyExportComplete(callbackUrl: string, invoiceId: string): Promise<void> {
    await fetch(callbackUrl, {
        method: "POST",
        body: JSON.stringify({ invoiceId }),
    });
}

export function isUnpaid(invoice: InvoiceSummary): boolean {
    return invoice.paidAt == null;
}
