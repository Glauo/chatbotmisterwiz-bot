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

const BOT_SELF_NUMBER = String(
    process.env.BOT_SELF_NUMBER ||
    process.env.WHATSAPP_BOT_NUMBER ||
    process.env.INSTANCE_PHONE ||
    process.env.OWNER_NUMBER ||
    ""
).replace(/\D/g, "");

const PAUSA_AUTOMATICA_ADMIN_ONLY = String(process.env.PAUSA_AUTOMATICA_ADMIN_ONLY || "true").toLowerCase() !== "false";
const DEBUG_WEBHOOK = String(process.env.DEBUG_WEBHOOK || "true").toLowerCase() === "true"; 

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.get('/', (req, res) => res.send('🤖 Bot com Memória ON!'));
app.get('/healthz', (req, res) => res.status(200).send('ok'));

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

app.post('/webhook', async (req, res) => {
    try {
        const body = req.body || {};
        const data = body.data || body;

        // Se estiver ativado, mostra todo o pacote de dados no log
        if (DEBUG_WEBHOOK) {
            console.log("🧭 WEBHOOK RAW START ---");
            console.log(JSON.stringify(body, null, 2).slice(0, 3000));
            console.log("--- WEBHOOK RAW END 🧭");
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

        // EXTRAÇÃO OFICIAL
        let rawJid = data?.key?.remoteJid || body?.key?.remoteJid || data?.remoteJid || body?.remoteJid || body?.sender?.id;
        
        if (!rawJid || typeof rawJid !== 'string') {
            return res.status(200).send('Ignorado (Sem JID)');
        }

        // Ignora status e grupos
        if (rawJid.includes('@broadcast') || rawJid.includes('status@') || rawJid.includes('@g.us')) {
            return res.status(200).send('Ignorado (Broadcast/Grupo)');
        }

        // ==========================================
        // 🎭 FUNÇÃO ANTI-MÁSCARA: Desvia de IDs @lid
        // ==========================================
        if (rawJid.includes('@lid') || rawJid.includes('@tampa') || !rawJid.includes('@')) {
            // Se o remetente oficial for uma máscara, procuramos o número real em outras "gavetas"
            const backupFields = [
                data?.key?.participant,
                body?.key?.participant,
                data?.sender,
                body?.sender,
                data?.participant,
                body?.participant
            ];

            for (const field of backupFields) {
                if (field && typeof field === 'string' && field.includes('@s.whatsapp.net') && !field.includes('@lid')) {
                    console.log(`🎭 MÁSCARA DETECTADA! Trocando LID (${rawJid}) pelo número real (${field})`);
                    rawJid = field;
                    break; // Achou o número real, para de procurar
                }
            }
        }

        // Limpa tudo, deixando apenas os números do cliente final
        const chatLimpo = rawJid.split('@')[0].replace(/\D/g, "");

        const messageText = getMessageText(body);

        if (!chatLimpo || !messageText) {
            return res.status(200).send('Ignorado (Falta dados)');
        }

        // Evita que o bot responda a si mesmo
        if (!fromMe && BOT_SELF_NUMBER && chatLimpo === BOT_SELF_NUMBER) {
            return res.status(200).send('Ignorado (Self)');
        }

        const texto = messageText.trim();
        const comando = texto.toLowerCase().split(" ")[0];
        const adminMatch = (chatLimpo === NUMERO_ADMIN);

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
        
        // Passamos o número limpo exato
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