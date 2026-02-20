const fs = require('fs');
const path = require('path');

const DEFAULT_KNOWLEDGE_FILE = path.resolve(
    __dirname,
    '..',
    '..',
    'data',
    'active_knowledge.json'
);

const ACTIVE_KNOWLEDGE_FILE = String(
    process.env.ACTIVE_KNOWLEDGE_FILE || DEFAULT_KNOWLEDGE_FILE
).trim() || DEFAULT_KNOWLEDGE_FILE;

const ACTIVE_KNOWLEDGE_TEXT = String(process.env.ACTIVE_KNOWLEDGE_TEXT || '').trim();
const MAX_CONTENT_CHARS = Number(process.env.ACTIVE_KNOWLEDGE_MAX_CHARS) || 120000;

function normalizeText(value) {
    return String(value || '').replace(/\r\n/g, '\n').trim();
}

function sanitizeContent(value) {
    const text = normalizeText(value);
    if (!text) return '';
    if (text.length <= MAX_CONTENT_CHARS) return text;
    return text.slice(0, MAX_CONTENT_CHARS);
}

function buildKnowledgePayload(record) {
    const title = normalizeText(record?.title || 'base_active');
    const content = sanitizeContent(record?.content || '');

    return {
        title: title || 'base_active',
        content,
        hasContent: Boolean(content)
    };
}

function readStoredRecord() {
    try {
        if (!fs.existsSync(ACTIVE_KNOWLEDGE_FILE)) return null;
        const raw = fs.readFileSync(ACTIVE_KNOWLEDGE_FILE, 'utf8');
        if (!raw || !raw.trim()) return null;

        try {
            const parsed = JSON.parse(raw);
            if (parsed && typeof parsed === 'object') return parsed;
        } catch {
            return {
                title: 'base_active',
                content: sanitizeContent(raw)
            };
        }
    } catch (error) {
        console.error('Erro ao ler base de conhecimento Active:', error.message || error);
    }

    return null;
}

function getActiveKnowledge() {
    const stored = buildKnowledgePayload(readStoredRecord() || {});
    const envText = sanitizeContent(ACTIVE_KNOWLEDGE_TEXT);
    const contentParts = [];

    if (stored.content) contentParts.push(stored.content);
    if (envText) contentParts.push(envText);

    const content = sanitizeContent(contentParts.join('\n\n'));
    const source =
        stored.content && envText
            ? 'file+env'
            : stored.content
              ? 'file'
              : envText
                ? 'env'
                : 'none';

    return {
        title: stored.title,
        content,
        source,
        hasContent: Boolean(content)
    };
}

function getActiveKnowledgeSnippet(maxChars = 2500) {
    const knowledge = getActiveKnowledge();
    if (!knowledge.content) return '';

    const limit = Number(maxChars) > 0 ? Number(maxChars) : 2500;
    if (knowledge.content.length <= limit) return knowledge.content;
    return `${knowledge.content.slice(0, limit)}\n[...]`;
}

module.exports = {
    getActiveKnowledge,
    getActiveKnowledgeSnippet
};
