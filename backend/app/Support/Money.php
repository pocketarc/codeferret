<?php

declare(strict_types=1);

namespace App\Support;

/**
 * Monetary amount in integer minor units (cents).
 */
final readonly class Money
{
    public function __construct(
        public int $amount,
        public string $currency = 'EUR',
    ) {}

    public static function fromMinor(int $amount, string $currency = 'EUR'): self
    {
        return new self($amount, $currency);
    }

    public function plus(self $other): self
    {
        if ($other->currency !== $this->currency) {
            throw new \InvalidArgumentException('Cannot add mismatched currencies.');
        }

        return new self($this->amount + $other->amount, $this->currency);
    }

    public function times(int $quantity): self
    {
        return new self($this->amount * $quantity, $this->currency);
    }
}
