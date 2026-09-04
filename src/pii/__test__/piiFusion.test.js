import { describe, it, expect } from 'vitest';
import { fusePII } from '../piiFusion';
describe('fusePII', () => {
    it('upgrades risk when regex and NER agree on the same region', () => {
        const regex = [
            { type: 'PERSON', bbox: [0, 0, 100, 20], confidence: 0.6, risk: 'MEDIUM', source: 'regex' }
        ];
        const ner = [
            { type: 'PERSON', bbox: [5, 0, 95, 20], confidence: 0.8, risk: 'MEDIUM', source: 'ner' }
        ];
        const [fused] = fusePII(regex, ner);
        expect(fused.corroborated).toBe(true);
        expect(fused.risk).toBe('HIGH');
    });
    it('leaves an uncorroborated candidate at its base risk', () => {
        const regex = [
            { type: 'LOCATION', bbox: [0, 0, 50, 20], confidence: 0.7, risk: 'LOW', source: 'regex' }
        ];
        const [fused] = fusePII(regex, []);
        expect(fused.corroborated).toBe(false);
        expect(fused.risk).toBe('LOW');
    });
});
