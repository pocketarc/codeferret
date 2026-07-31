<?php

declare(strict_types=1);

use App\Http\Controllers\InvoiceController;
use Illuminate\Support\Facades\Route;

Route::middleware('auth:sanctum')->group(function () {
    Route::get('/invoices', [InvoiceController::class, 'index']);
    Route::get('/invoices/export', [InvoiceController::class, 'export']);
    Route::get('/invoices/{id}', [InvoiceController::class, 'show']);
    Route::delete('/invoices/{id}', [InvoiceController::class, 'destroy']);
});
