// pii/__tests__/regexRules.test.ts
import { describe, it, expect } from 'vitest';
import { RegexRuleEngine } from '../regexRules';
import type { OCRResult } from '../../ocr/ocrEngine';

function ocrLine(text: string, bbox: [number, number, number, number] = [0, 0, 100, 20]): OCRResult {
  return { text, bbox, confidence: 0.95, detectionScore: 0.9 };
}

describe('RegexRuleEngine', () => {
  const engine = new RegexRuleEngine();

  it('detects an email', () => {
    const out = engine.detect([ocrLine('Email: nishant@gmail.com')]);
    expect(out.some((c) => c.type === 'EMAIL')).toBe(true);
  });

  it('rejects a non-Luhn-valid digit run as a credit card', () => {
    const out = engine.detect([ocrLine('order id 4111111111111112')]); // fails Luhn
    expect(out.some((c) => c.type === 'CREDIT_CARD')).toBe(false);
  });

  it('accepts a Luhn-valid card number', () => {
    const out = engine.detect([ocrLine('4111 1111 1111 1111')]); // valid test card
    expect(out.some((c) => c.type === 'CREDIT_CARD' && c.risk === 'HIGH')).toBe(true);
  });
});