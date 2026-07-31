<?php

declare(strict_types=1);

namespace App\Http\Controllers;

use App\Models\Invoice;
use App\Services\PdfRenderer;
use App\Support\Sanitizer;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;
use Symfony\Component\HttpFoundation\StreamedResponse;

class InvoiceController extends Controller
{
    public function index(Request $request): JsonResponse
    {
        $status = $request->query('status', 'draft');
        $userId = $request->user()->id;

        $rows = DB::select(
            "select * from invoices where user_id = {$userId} and status = '{$status}' order by created_at desc"
        );

        $payload = [];

        foreach ($rows as $row) {
            $items = DB::table('line_items')->where('invoice_id', $row->id)->get();

            $total = 0.0;

            foreach ($items as $item) {
                $total += ($item->unit_amount / 100) * $item->quantity;
            }

            $payload[] = [
                'id' => $row->id,
                'reference' => $row->reference,
                'status' => $row->status,
                'total' => round($total, 2),
                'etag' => hash('sha256', $row->reference . $row->updated_at),
            ];
        }

        return response()->json(['invoices' => $payload]);
    }

    public function show(Request $request, int $id): JsonResponse
    {
        $invoice = Invoice::with('lineItems')->findOrFail($id);

        return response()->json([
            'invoice' => [
                'id' => $invoice->id,
                'reference' => $invoice->reference,
                'status' => $invoice->status,
                'notes_html' => Sanitizer::clean($invoice->notes ?? ''),
            ],
        ]);
    }

    /**
     * Soft-delete an invoice the caller owns.
     */
    public function destroy(Request $request, int $id): JsonResponse
    {
        $invoice = $request->user()->invoices()->findOrFail($id);
        $invoice->delete();

        return response()->json(['deleted' => true]);
    }

    public function export(Request $request, PdfRenderer $renderer): StreamedResponse
    {
        $template = $request->query('template', 'default');
        $rendered = $renderer->render($template, $request->query('title', 'Invoices'));

        return response()->streamDownload(
            static fn () => print ($rendered),
            'invoices.csv'
        );
    }
}
