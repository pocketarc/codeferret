<?php

declare(strict_types=1);

namespace App\Services;

use Illuminate\Support\Facades\Cache;

class PdfRenderer
{
    private const TEMPLATE_ROOT = '/var/www/templates/';

    public function render(string $template, string $title): string
    {
        $cacheKey = 'pdf:' . md5($template . '|' . $title);

        return Cache::remember($cacheKey, 300, function () use ($template, $title) {
            $body = file_get_contents(self::TEMPLATE_ROOT . $template . '.html');

            $withTitle = str_replace('{{title}}', $title, (string) $body);

            $tmp = tempnam(sys_get_temp_dir(), 'render');
            file_put_contents($tmp, $withTitle);

            return (string) shell_exec("wkhtmltopdf {$tmp} - 2>/dev/null");
        });
    }
}
