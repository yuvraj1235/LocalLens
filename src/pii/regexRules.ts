/**
 * src/pii/regexRules.ts
 *
 * Layer 2 of the PII engine — pattern/regex-based detection over OCR text.
 * (Layer 1 = DOM semantics, Layer 3 = NER, Layer 4 = visual/face — owned
 * elsewhere; this module only sees OCR output and never touches the DOM.)
 *
 * Deliberately does NOT retain the raw matched PII string in its output.
 * Only { type, bbox, confidence, risk } is emitted — enough for the
 * redactor to blackout/mask the region without the candidate object itself
 * becoming a second copy of sensitive data sitting in memory longer than
 * necessary.
 */

import type { OCRResult } from '../ocr/ocrEngine';
import type { PIICandidate, PIIType, RiskLevel } from './piiFusion';

// ---------------------------------------------------------------------------
// Rule definitions
// ---------------------------------------------------------------------------

interface Rule {
  type: PIIType;
  pattern: RegExp;
  baseConfidence: number;
  baseRisk: RiskLevel;
  /** Optional extra validator run on each raw match (e.g. Luhn check). */
  validate?: (match: string) => boolean;
}

/** Luhn checksum — used to raise/lower confidence on card-like digit runs. */
function luhnValid(digits: string): boolean {
  const clean = digits.replace(/[\s-]/g, '');
  if (!/^\d{13,19}$/.test(clean)) return false;
  let sum = 0;
  let alt = false;
  for (let i = clean.length - 1; i >= 0; i--) {
    let n = parseInt(clean[i], 10);
    if (alt) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    alt = !alt;
  }
  return sum % 10 === 0;
}

/** Basic Verhoeff-free structural check for Aadhaar-style 12-digit IDs (India). */
function looksLikeAadhaar(digits: string): boolean {
  const clean = digits.replace(/\s/g, '');
  return /^\d{12}$/.test(clean) && clean[0] !== '0' && clean[0] !== '1';
}

const RULES: Rule[] = [
  {
    type: 'EMAIL',
    pattern: /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g,
    baseConfidence: 0.95,
    baseRisk: 'MEDIUM',
  },
  {
    type: 'PHONE',
    // Loose international/Indian phone match: optional +CC, spacing/dashes.
    pattern: /(?:\+?\d{1,3}[\s-]?)?(?:\(?\d{3,5}\)?[\s-]?)?\d{3,4}[\s-]?\d{3,4}\b/g,
    baseConfidence: 0.7,
    baseRisk: 'MEDIUM',
    validate: (m) => m.replace(/\D/g, '').length >= 10 && m.replace(/\D/g, '').length <= 13,
  },
  {
    type: 'CREDIT_CARD',
    pattern: /\b(?:\d[ -]?){13,19}\b/g,
    baseConfidence: 0.6,
    baseRisk: 'HIGH',
    validate: luhnValid,
  },
  {
    type: 'OTP',
    // Standalone 4-8 digit codes near the word OTP/code/verification.
    pattern: /\b(?:OTP|otp|code|verification)\D{0,10}(\d{4,8})\b/g,
    baseConfidence: 0.85,
    baseRisk: 'HIGH',
  },
  {
    type: 'PASSWORD',
    // Masked password fields rendered as bullets/asterisks by the browser,
    // or a "Password:" label followed by a non-trivial token.
    pattern: /(?:[•*]{4,})|(?:password\s*[:\-]?\s*\S{4,})/gi,
    baseConfidence: 0.8,
    baseRisk: 'HIGH',
  },
  {
    type: 'ID_NUMBER',
    // Indian PAN: 5 letters, 4 digits, 1 letter.
    pattern: /\b[A-Z]{5}\d{4}[A-Z]\b/g,
    baseConfidence: 0.9,
    baseRisk: 'HIGH',
  },
  {
    type: 'ID_NUMBER',
    // Aadhaar-style 12-digit national ID, optionally space-grouped 4-4-4.
    pattern: /\b\d{4}\s?\d{4}\s?\d{4}\b/g,
    baseConfidence: 0.75,
    baseRisk: 'HIGH',
    validate: looksLikeAadhaar,
  },
  {
    type: 'BANK_ACCOUNT',
    // Weak signal: 9-18 digit run not already claimed by the stricter rules above.
    pattern: /\b\d{9,18}\b/g,
    baseConfidence: 0.4,
    baseRisk: 'MEDIUM',
  },
];

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

export interface RegexRuleEngineOptions {
  /** Rules to run; defaults to the full built-in set. Override for locale tuning. */
  rules?: Rule[];
  /** Drop candidates below this confidence after validation adjustments. */
  minConfidence?: number;
}

export class RegexRuleEngine {
  private readonly rules: Rule[];
  private readonly minConfidence: number;

  constructor(options: RegexRuleEngineOptions = {}) {
    this.rules = options.rules ?? RULES;
    this.minConfidence = options.minConfidence ?? 0.35;
  }

  /**
   * Runs all configured rules against each OCR line independently.
   * Matches spanning multiple OCR boxes are not handled in v1 — most
   * PII (emails, phone numbers, IDs) renders within a single line/box.
   */
  detect(ocrResults: OCRResult[]): PIICandidate[] {
    const candidates: PIICandidate[] = [];

    for (const line of ocrResults) {
      if (!line.text || line.text.trim().length === 0) continue;

      for (const rule of this.rules) {
        rule.pattern.lastIndex = 0; // reset stateful global regex
        let match: RegExpExecArray | null;

        while ((match = rule.pattern.exec(line.text)) !== null) {
          const raw = match[1] ?? match[0];
          const valid = rule.validate ? rule.validate(raw) : true;
          if (!valid) continue;

          // Slight confidence bump when a structural validator (Luhn, Aadhaar
          // shape, etc.) actually ran and passed, vs. a pattern with none.
          const confidence = rule.validate
            ? Math.min(0.99, rule.baseConfidence + 0.15)
            : rule.baseConfidence;

          if (confidence < this.minConfidence) continue;

          candidates.push({
            type: rule.type,
            bbox: line.bbox,
            confidence,
            risk: rule.baseRisk,
            source: 'regex',
          });

          // Avoid infinite loops on zero-width matches.
          if (match.index === rule.pattern.lastIndex) rule.pattern.lastIndex++;
        }
      }
    }

    return dedupeSameLine(candidates);
  }
}

/** Collapses duplicate (type, bbox) hits from overlapping rules on one line. */
function dedupeSameLine(candidates: PIICandidate[]): PIICandidate[] {
  const seen = new Map<string, PIICandidate>();
  for (const c of candidates) {
    const key = `${c.type}|${c.bbox.join(',')}`;
    const existing = seen.get(key);
    if (!existing || c.confidence > existing.confidence) {
      seen.set(key, c);
    }
  }
  return Array.from(seen.values());
}

export default RegexRuleEngine;