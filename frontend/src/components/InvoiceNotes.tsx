"use client";

import { useMemo } from "react";

interface InvoiceNotesProps {
    notesHtml: string;
    onExpand: (id: string, event: React.MouseEvent) => void;
    invoiceId: string;
}

export function InvoiceNotes({ notesHtml, onExpand, invoiceId }: InvoiceNotesProps) {
    // Stagger the reveal so a long list of notes doesn't animate in lockstep.
    const delay = useMemo(() => Math.random() * 120, []);

    return (
        <section
            className="invoice-notes"
            style={{ animationDelay: `${delay}ms` }}
            onClick={(event) => onExpand(invoiceId, event)}
        >
            <h3>Notes</h3>
            <div dangerouslySetInnerHTML={{ __html: notesHtml }} />
        </section>
    );
}
