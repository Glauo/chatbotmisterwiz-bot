const axios = require('axios');
require('dotenv').config();
const DEBUG_WEBHOOK = String(process.env.DEBUG_WEBHOOK || '').toLowerCase() === 'true';
const PHONE_COUNTRY_PREFIX = String(process.env.PHONE_COUNTRY_PREFIX || '55').replace(/\D/g, '');

function readEnv(...keys) {
    for (const key of keys) {
        const value = process.env[key];
        if (typeof value === 'string' && value.trim()) return value.trim();
    }
    return '';
}

// Accept both legacy EVOLUTION_* and custom Portuguese variable names from Railway.
const EVOLUTION_API_URL = readEnv(
    'EVOLUTION_API_URL',
    'URL_DA_API_DE_EVOLUCAO',
    'URL_DA_API_DE_EVOLUÇÃO',
    'URL_da_API_de_EVOLUCAO',
    'URL_da_API_de_EVOLUÇÃO'
);

const EVOLUTION_API_KEY = readEnv(
    'EVOLUTION_API_KEY',
    'CHAVE_API_DE_EVOLUCAO',
    'CHAVE_API_DE_EVOLUÇÃO',
    'CHAVE_API_DE_AUTENTICACAO',
    'CHAVE_API_DE_AUTENTICAÇÃO',
    'AUTHENTICATION_API_KEY'
);

const EVOLUTION_INSTANCE = readEnv(
    'EVOLUTION_INSTANCE',
    'INSTANCIA_DE_EVOLUCAO',
    'INSTANCIA_DE_EVOLUÇÃO',
    'INSTÂNCIA_DE_EVOLUCAO',
    'INSTÂNCIA_DE_EVOLUÇÃO'
);

function cleanNumber(value) {
    if (!value) return '';
    const raw = String(value);
    const base = raw.split('@')[0];
    return base.replace(/\D/g, '');
}

function unique(values) {
    const out = [];
    const seen = new Set();
    for (const value of values) {
        const key = String(value || '').trim();
        if (!key || seen.has(key)) continue;
        seen.add(key);
        out.push(key);
    }
    return out;
}

function buildNumberCandidates(value) {
    const raw = String(value || '').trim();
    if (!raw) return [];

    const base = raw.split(':')[0].trim();
    const hasJid = base.includes('@');
    const digits = base.replace(/\D/g, '');

    const candidates = [];
    if (hasJid) {
        const low = base.toLowerCase();
        if (low.endsWith('@s.whatsapp.net') || low.endsWith('@c.us')) {
            candidates.push(base);
        }
    }
    if (digits) {
        const prefixOk = !PHONE_COUNTRY_PREFIX || digits.startsWith(PHONE_COUNTRY_PREFIX);
        if (prefixOk) {
            candidates.push(digits);
            candidates.push(`${digits}@s.whatsapp.net`);
        }
    }

    return unique(candidates);
}

function buildEvolutionUrl() {
    const base = String(EVOLUTION_API_URL || '').replace(/\/+$/, '');
    const instance = encodeURIComponent(String(EVOLUTION_INSTANCE || ''));
    if (!base || !instance) return '';
    return `${base}/message/sendText/${instance}`;
}

async function sendMessage(phone, message) {
    try {
        if (!EVOLUTION_API_URL || !EVOLUTION_API_KEY || !EVOLUTION_INSTANCE) {
            console.error('Evolution API not configured. Missing URL/KEY/INSTANCE variables.');
            return;
        }

        const url = buildEvolutionUrl();
        const sourceList = Array.isArray(phone) ? phone : [phone];
        const candidates = unique(sourceList.flatMap(buildNumberCandidates));
        if (!candidates.length) {
            console.error('Invalid number for send:', phone);
            return;
        }

        const config = {
            headers: {
                apikey: EVOLUTION_API_KEY,
                'Content-Type': 'application/json'
            }
        };

        // Tenta múltiplos formatos/destinos (inclui JID bruto quando existir).
        let lastError = null;

        for (const candidate of candidates) {
            try {
                console.log(`Sending to ${candidate}...`);
                const payload = { number: candidate, text: message };
                const response = await axios.post(url, payload, config);
                if (DEBUG_WEBHOOK) {
                    try {
                        console.log('EVO SEND RESPONSE:', JSON.stringify(response.data));
                    } catch (e) {
                        console.log('EVO SEND RESPONSE: <serialize error>');
                    }
                }
                console.log('Message sent.');
                return response.data;
            } catch (error) {
                lastError = error;
                const status = error?.response?.status;
                if (status !== 400) break;
                if (DEBUG_WEBHOOK) {
                    console.log(`EVO SEND fallback: formato ${candidate} rejeitado com 400, tentando próximo...`);
                }
            }
        }
        throw lastError || new Error('Falha desconhecida ao enviar mensagem');
    } catch (error) {
        console.error('Evolution API send error:');
        if (error.response) {
            console.error(`Status: ${error.response.status}`);
            console.error('Detail:', JSON.stringify(error.response.data, null, 2));
        } else {
            console.error(error.message);
        }
    }
}

module.exports = { sendMessage };
