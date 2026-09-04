/**
 * src/pii/nerEngine.ts
 *
 * Layer 3 of the PII engine — small BERT/DeBERTa-style NER model run
 * locally via ONNX Runtime Web, for entity classes that regex can't catch:
 * PERSON, LOCATION, ORGANIZATION, ADDRESS.
 *
 * Runs per OCR line (not the whole page as one string) so that a detected
 * entity's bounding box can be approximated from the OCR line's own bbox
 * without needing full attention-based alignment. This is a v1
 * simplification — see the TODO near `mapEntityToBBox` for sub-line boxes.
 *
 * Includes a minimal in-file WordPiece tokenizer so this module has no
 * dependency beyond onnxruntime-web and a vocab file, matching the rest of
 * the local-vision-pipeline's "no heavy external deps" constraint.
 */
import * as ort from 'onnxruntime-web';
// ---------------------------------------------------------------------------
// Label scheme (BIO tagging)
// ---------------------------------------------------------------------------
const LABELS = [
    'O',
    'B-PERSON',
    'I-PERSON',
    'B-LOCATION',
    'I-LOCATION',
    'B-ORGANIZATION',
    'I-ORGANIZATION',
    'B-ADDRESS',
    'I-ADDRESS',
];
const ENTITY_TO_PII_TYPE = {
    PERSON: 'PERSON',
    LOCATION: 'LOCATION',
    ORGANIZATION: 'ORGANIZATION',
    ADDRESS: 'ADDRESS',
};
const ENTITY_BASE_RISK = {
    PERSON: 'MEDIUM',
    ADDRESS: 'MEDIUM',
    LOCATION: 'LOW',
    ORGANIZATION: 'LOW',
};
class WordPieceTokenizer {
    constructor(vocab, maxLen = 128) {
        this.vocab = vocab;
        this.unkId = vocab.get('[UNK]') ?? 100;
        this.clsId = vocab.get('[CLS]') ?? 101;
        this.sepId = vocab.get('[SEP]') ?? 102;
        this.maxLen = maxLen;
    }
    static async fromUrl(url) {
        const res = await fetch(url);
        if (!res.ok)
            throw new Error(`nerEngine: failed to load vocab from ${url} (${res.status})`);
        const text = await res.text();
        const vocab = new Map();
        text.split('\n').forEach((line, idx) => {
            const token = line.replace(/\r$/, '');
            if (token.length > 0)
                vocab.set(token, idx);
        });
        return new WordPieceTokenizer(vocab);
    }
    /** Whitespace/punctuation pre-tokenization, then greedy longest-match WordPiece. */
    tokenize(text) {
        const words = this.basicSplit(text);
        const tokenIds = [this.clsId];
        const offsets = [[-1, -1]]; // [CLS] has no span
        for (const [word, start, end] of words) {
            const pieces = this.wordPiece(word.toLowerCase());
            if (tokenIds.length + pieces.length >= this.maxLen - 1)
                break;
            // Distribute the word's char span evenly across its subword pieces
            // as a coarse approximation (exact per-piece offsets aren't needed
            // since we only use offsets to fall back to the parent word's span).
            for (const p of pieces) {
                tokenIds.push(p);
                offsets.push([start, end]);
            }
        }
        tokenIds.push(this.sepId);
        offsets.push([-1, -1]);
        return { tokenIds, offsets };
    }
    basicSplit(text) {
        const words = [];
        const re = /[A-Za-z0-9]+|[^\sA-Za-z0-9]/g;
        let m;
        while ((m = re.exec(text)) !== null) {
            words.push([m[0], m.index, m.index + m[0].length]);
        }
        return words;
    }
    wordPiece(word) {
        if (this.vocab.has(word))
            return [this.vocab.get(word)];
        const pieces = [];
        let start = 0;
        let unresolved = false;
        while (start < word.length) {
            let end = word.length;
            let matched = null;
            while (end > start) {
                const sub = (start > 0 ? '##' : '') + word.slice(start, end);
                if (this.vocab.has(sub)) {
                    matched = sub;
                    break;
                }
                end--;
            }
            if (matched === null) {
                unresolved = true;
                break;
            }
            pieces.push(this.vocab.get(matched));
            start = end;
        }
        return unresolved ? [this.unkId] : pieces;
    }
}
export class NEREngine {
    constructor(config) {
        this.session = null;
        this.tokenizer = null;
        this.ready = false;
        this.config = {
            maxSequenceLength: 128,
            minConfidence: 0.5,
            ...config,
        };
    }
    get isReady() {
        return this.ready;
    }
    async initialize() {
        if (this.ready)
            return;
        const executionProviders = this.config.executionProviders ??
            (typeof navigator !== 'undefined' && 'gpu' in navigator ? ['webgpu', 'wasm'] : ['wasm']);
        const [session, tokenizer] = await Promise.all([
            ort.InferenceSession.create(this.config.modelUrl, {
                executionProviders,
                graphOptimizationLevel: 'all',
            }),
            WordPieceTokenizer.fromUrl(this.config.vocabUrl),
        ]);
        this.session = session;
        this.tokenizer = tokenizer;
        this.ready = true;
    }
    async dispose() {
        await this.session?.release();
        this.session = null;
        this.tokenizer = null;
        this.ready = false;
    }
    /** Runs NER over each OCR line and returns PII candidates for PERSON/LOCATION/ORG/ADDRESS. */
    async detect(ocrResults) {
        if (!this.ready || !this.session || !this.tokenizer) {
            throw new Error('NEREngine.initialize() must be awaited before detect().');
        }
        const candidates = [];
        for (const line of ocrResults) {
            if (!line.text || line.text.trim().length < 2)
                continue;
            const lineCandidates = await this.detectInLine(line);
            candidates.push(...lineCandidates);
        }
        return candidates;
    }
    async detectInLine(line) {
        const { tokenIds, offsets } = this.tokenizer.tokenize(line.text);
        const seqLen = tokenIds.length;
        const inputIds = new BigInt64Array(tokenIds.map((id) => BigInt(id)));
        const attentionMask = new BigInt64Array(seqLen).fill(1n);
        const tokenTypeIds = new BigInt64Array(seqLen).fill(0n);
        const feeds = {
            input_ids: new ort.Tensor('int64', inputIds, [1, seqLen]),
            attention_mask: new ort.Tensor('int64', attentionMask, [1, seqLen]),
            token_type_ids: new ort.Tensor('int64', tokenTypeIds, [1, seqLen]),
        };
        const outputs = await this.session.run(feeds);
        const logits = outputs[Object.keys(outputs)[0]];
        const data = logits.data;
        const numLabels = LABELS.length;
        const perTokenLabel = [];
        const perTokenConfidence = [];
        for (let t = 0; t < seqLen; t++) {
            const offset = t * numLabels;
            let bestIdx = 0;
            let bestVal = data[offset];
            for (let c = 1; c < numLabels; c++) {
                if (data[offset + c] > bestVal) {
                    bestVal = data[offset + c];
                    bestIdx = c;
                }
            }
            perTokenLabel.push(LABELS[bestIdx]);
            perTokenConfidence.push(softmaxScore(data, offset, numLabels, bestIdx));
        }
        return this.decodeEntities(perTokenLabel, perTokenConfidence, offsets, line);
    }
    /** BIO decode -> contiguous entity spans -> PIICandidate, one per entity. */
    decodeEntities(labels, confidences, offsets, line) {
        const results = [];
        let currentType = null;
        let currentConfs = [];
        const flush = () => {
            if (currentType && currentConfs.length > 0) {
                const meanConf = currentConfs.reduce((a, b) => a + b, 0) / currentConfs.length;
                if (meanConf >= this.config.minConfidence) {
                    const piiType = ENTITY_TO_PII_TYPE[currentType];
                    if (piiType) {
                        results.push({
                            type: piiType,
                            // TODO(sub-line-bbox): once OCR emits word-level boxes, narrow
                            // this to the entity's actual char span instead of the full line.
                            bbox: line.bbox,
                            confidence: meanConf,
                            risk: ENTITY_BASE_RISK[currentType] ?? 'LOW',
                            source: 'ner',
                        });
                    }
                }
            }
            currentType = null;
            currentConfs = [];
        };
        for (let i = 0; i < labels.length; i++) {
            const label = labels[i];
            if (offsets[i][0] === -1)
                continue; // skip [CLS]/[SEP]
            if (label === 'O') {
                flush();
                continue;
            }
            const [tag, entityType] = label.split('-');
            if (tag === 'B') {
                flush();
                currentType = entityType;
                currentConfs = [confidences[i]];
            }
            else if (tag === 'I' && currentType === entityType) {
                currentConfs.push(confidences[i]);
            }
            else {
                // I- tag without a matching B- (malformed sequence) — start fresh.
                flush();
                currentType = entityType;
                currentConfs = [confidences[i]];
            }
        }
        flush();
        return results;
    }
}
function softmaxScore(data, offset, numLabels, idx) {
    let sum = 0;
    const max = data[offset + idx];
    for (let c = 0; c < numLabels; c++)
        sum += Math.exp(data[offset + c] - max);
    return 1 / sum; // exp(0)/sum since we subtracted the max at idx
}
export default NEREngine;
