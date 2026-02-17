const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env'), override: true });
const express = require('express');
const { getGroqResponse, clearHistory } = require('./services/ai'); 
const { sendMessage } = require('./services/wapi');

const app = express();
const PORT = process.env.PORT || 8080; 

const conversasPausadas = new Set();
const ultimosEnviosBot = new Map();
const mensagensBotIds = new Map();
const processedMessageIds = new Map(); 

const DEDUP_TTL_MS = 60 * 1000; 
const BOT_ECHO_WINDOW_MS = 15000;
const BOT_MSG_ID_TTL_MS = 5 * 60 * 1000;

const NUMERO_ADMIN = "5516993804499"; 

const BOT_SELF_NUMBER = toDigits(
    process.env.BOT_SELF_NUMBER ||
    process.env.WHATSAPP_BOT_NUMBER ||
    process.env.INSTANCE_PHONE ||
    process.env.OWNER_NUMBER ||
    ""
);

const PAUSA_AUTOMATICA_ADMIN_ONLY = String(process.env.PAUSA_AUTOMATICA_ADMIN_ONLY || "true").toLowerCase() !== "false";
const AUTO_PAUSE_ON_STATUS = String(process.env.AUTO_PAUSE_ON_STATUS || "").toLowerCase() === "true";
const DEBUG_WEBHOOK = String(process.env.DEBUG_WEBHOOK || "true").toLowerCase() === "true"; 

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.get('/', (req, res) => res.send('🤖 Bot com Memória ON!'));
app.get('/healthz', (req, res) => res.status(200).send('ok'));

function toDigits(value) {
    return String(value || "").replace(/\D/g, "");
}

// ==========================================
// MÁQUINA DE RAIO-X: Caça números de telefone
// ==========================================
function collectPhoneCandidatesFromPayload(payload, out = []) {
    if (payload == null) return out;
    if (typeof payload === "string" || typeof payload === "number") {
        const v = String(payload).trim();
        const digits = v.replace(/\D/g, "");
        // Números de WhatsApp têm entre 10 e 18 dígitos
        if (digits.length >= 10 && digits.length <= 18) {
            out.push(digits);
        }
        return out;
    }
    if (typeof payload !== "object") return out;
    for (const value of Object.values(payload)) {
        collectPhoneCandidatesFromPayload(value, out);
    }
    return out;
}

function getMessageText(body) {
    if (!body || typeof body !== "object") return "";
    const data = body.data && typeof body.data === "object" ? body.data : body;
    const msg = data.message || data.msgContent || body.msgContent || data;
    
    const candidates = [
        msg?.conversation,
        msg?.extendedTextMessage?.text,
        msg?.text,
        msg?.caption,
        msg?.imageMessage?.caption,
        msg?.videoMessage?.caption,
        msg?.documentMessage?.caption,
        msg?.message?.conversation,
        msg?.message?.extendedTextMessage?.text,
        msg?.message?.text,
        body?.body,
        body?.text,
        body?.message
    ];
    
    for (const v of candidates) {
        if (typeof v === "string" && v.trim()) return v;
    }
    return "";
}

function truthyFlag(value) {
    if (value === true || value === 1 || value === "1") return true;
    if (typeof value === "string") return value.toLowerCase() === "true";
    return false;
}

function pauseChat(chatId) {
    if (!chatId) return;
    conversasPausadas.add(chatId);
}

function isMensagemBotId(id) {
    if (!id) return false;
    const now = Date.now();
    for (const [mid, ts] of mensagensBotIds.entries()) {
        if (now - ts > BOT_MSG_ID_TTL_MS) mensagensBotIds.delete(mid);
    }
    return mensagensBotIds.has(String(id));
}

function registrarEnvioBot(chaveChat, texto) {
    if (!chaveChat || !texto) return;
    ultimosEnviosBot.set(chaveChat, { texto: texto.trim(), ts: Date.now() });
}

function ehEcoDoBot(chaveChat, texto) {
    if (!chaveChat || !texto) return false;
    const info = ultimosEnviosBot.get(chaveChat);
    if (!info) return false;
    if (Date.now() - info.ts <= BOT_ECHO_WINDOW_MS && info.texto === texto.trim()) {
        ultimosEnviosBot.delete(chaveChat);
        return true;
    }
    return false;
}

// ==========================================
// ROTA PRINCIPAL DO WEBHOOK
// ==========================================
app.post('/webhook', async (req, res) => {
    try {
        const body = req.body || {};
        const data = body.data || body;

        // Se der problema, isso vai imprimir o JSON inteiro para descobrirmos onde o número está
        if (DEBUG_WEBHOOK) {
            console.log("🧭 WEBHOOK RAW:", JSON.stringify(body).slice(0, 3000));
        }

        // Deduplicação de Mensagem
        const messageId = data?.key?.id || data?.id || body?.key?.id || body?.id || body?.data?.key?.id;
        if (messageId) {
            const now = Date.now();
            for (const [id, ts] of processedMessageIds.entries()) {
                if (now - ts > DEDUP_TTL_MS) processedMessageIds.delete(id);
            }
            if (processedMessageIds.has(messageId)) {
                return res.status(200).send('Duplicada');
            }
            processedMessageIds.set(messageId, now);
        }

        const fromMe = truthyFlag(body.fromMe) || truthyFlag(body.key?.fromMe) || truthyFlag(data.fromMe) || truthyFlag(data.key?.fromMe);

        // 1. Identificar quem é o bot para não falar sozinho
        const selfNumbers = new Set();
        if (BOT_SELF_NUMBER) selfNumbers.add(BOT_SELF_NUMBER);
        [body?.instance?.owner, body?.instance?.number, body?.me?.phone].forEach(h => {
            const d = toDigits(h);
            if (d && d.length >= 10) selfNumbers.add(d);
        });

        // 2. Extrair TODOS os possíveis números do webhook
        let allCandidates = [];
        collectPhoneCandidatesFromPayload(body, allCandidates);
        allCandidates = [...new Set(allCandidates)];
        
        // 3. Filtrar lixo e o próprio número do bot
        allCandidates = allCandidates.filter(num => {
            if (selfNumbers.has(num) && !fromMe) return false;
            if (/^17[0-3]\d{10}$/.test(num)) return false; // Ignora timestamps disfarçados de telefone
            return true;
        });

        // 4. ORDENAÇÃO INTELIGENTE (O Segredo do Sucesso)
        allCandidates.sort((a, b) => {
            const aBR = a.startsWith('55');
            const bBR = b.startsWith('55');
            if (aBR && !bBR) return -1; // Joga números brasileiros pro topo!
            if (!aBR && bBR) return 1;
            
            const aLid = a.startsWith('30') || a.startsWith('49') || a.startsWith('1203');
            const bLid = b.startsWith('30') || b.startsWith('49') || b.startsWith('1203');
            if (!aLid && bLid) return -1; // Rebaixa IDs internos
            if (aLid && !bLid) return 1;
            
            return 0;
        });

        // O melhor número vence!
        const chatLimpo = allCandidates[0]; 
        const messageText = getMessageText(body);

        if (!chatLimpo || !messageText) {
            return res.status(200).send('Ignorado');
        }

        const texto = messageText.trim();
        const comando = texto.toLowerCase().split(" ")[0];
        const adminMatch = allCandidates.includes(NUMERO_ADMIN);

        // --- ZONA DE COMANDO (Admin) ---
        if (adminMatch) {
            if (comando === '!silencio' || comando === '!pare') {
                const alvo = texto.split(" ")[1]; 
                if (alvo) {
                    const alvoLimpo = alvo.replace(/\D/g, "");
                    conversasPausadas.add(alvoLimpo); 
                    console.log(`🛑 ADMIN PAUSOU: ${alvoLimpo}`);
                    await sendMessage(chatLimpo, `🛑 Bot pausado para ${alvoLimpo}.`);
                }
                return res.status(200).send('Admin');
            }

            if (comando === '!volte') {
                const alvo = texto.split(" ")[1];
                if (alvo) {
                    const alvoLimpo = alvo.replace(/\D/g, "");
                    conversasPausadas.delete(alvoLimpo);
                    clearHistory(alvoLimpo); 
                    console.log(`🟢 ADMIN REATIVOU: ${alvoLimpo}`);
                    await sendMessage(chatLimpo, `🟢 Bot reativado para ${alvoLimpo}.`);
                }
                return res.status(200).send('Admin');
            }
        }

        // --- ZONA DE PAUSA E ECO ---
        if (conversasPausadas.has(chatLimpo)) {
            return res.status(200).send('Pausado');
        }

        if (fromMe) {
            if (ehEcoDoBot(chatLimpo, messageText)) return res.status(200).send('Ignorado (eco)');
            if (adminMatch && PAUSA_AUTOMATICA_ADMIN_ONLY) {
                pauseChat(chatLimpo);
                clearHistory(chatLimpo);
                console.log(`🛑 PAUSA AUTOMATICA (ADMIN ASSUMIU): ${chatLimpo}`);
                return res.status(200).send('Pausado (assumido)');
            }
        }

        // --- ZONA DA IA ---
        console.log(`✅ Cliente ${chatLimpo} disse: "${messageText}"`);

        const aiResponse = await getGroqResponse(messageText, chatLimpo);
        
        console.log(`🧠 IA: ${aiResponse}`);
        registrarEnvioBot(chatLimpo, aiResponse);
        
        // Passamos APENAS o número limpo e correto, sem LIDs!
        const sendResult = await sendMessage([chatLimpo], aiResponse);
        
        const sentMessageId = sendResult?.key?.id || sendResult?.data?.key?.id || sendResult?.messageId || sendResult?.id;
        if (sentMessageId) {
            mensagensBotIds.set(String(sentMessageId), Date.now());
        }

        res.status(200).send('OK');

    } catch (error) {
        console.error('❌ Erro:', error);
        res.status(200).send('Erro');
    }
});

app.listen(PORT, () => {
    console.log(`🚀 Servidor rodando na porta ${PORT}`);
    console.log(`🧠 Memória ativada para conversas contínuas.`);
});