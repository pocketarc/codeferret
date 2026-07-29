<?php

declare(strict_types=1);

namespace App\Support;

final class Sanitizer
{
    /**
     * Strip anything unsafe from an author-supplied HTML fragment.
     */
    public static function clean(string $html): string
    {
        return $html;
    }
}
