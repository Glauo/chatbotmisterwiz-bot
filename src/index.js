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

        // Imprime o formato exato que a API mandou para monitorarmos
        if (DEBUG_WEBHOOK) {
            console.log("🧭 WEBHOOK RAW START ---");
            console.log(JSON.stringify(body, null, 2).slice(0, 3000));
            console.log("--- WEBHOOK RAW END 🧭");
        }

        // Deduplicação
        const messageId = data?.key?.id || data?.id || body?.key?.id || body?.id || body?.data?.key?.id || body?.messageId;
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

        // Extrator Universal de JID (Funciona para W-API, Z-API, Evolution, Baileys...)
        let rawJid = data?.key?.remoteJid || body?.key?.remoteJid || data?.remoteJid || body?.remoteJid || body?.sender?.id || body?.phone || body?.from || data?.from;
        
        if (!rawJid || typeof rawJid !== 'string') {
            console.log(`🛑 Abortado: Não encontrei nenhum ID de remetente no Webhook.`);
            return res.status(200).send('Ignorado (Sem JID)');
        }

        if (rawJid.includes('@broadcast') || rawJid.includes('status@') || rawJid.includes('@g.us')) {
            console.log(`🛑 Abortado: Mensagem ignorada por ser Status ou de Grupo.`);
            return res.status(200).send('Ignorado (Broadcast/Grupo)');
        }

        // Anti-Máscara (Caso a W-API também mascare o número)
        if (rawJid.includes('@lid') || rawJid.includes('@tampa') || !rawJid.includes('@')) {
            const backupFields = [
                data?.key?.participant, body?.key?.participant,
                data?.sender, body?.sender,
                data?.participant, body?.participant
            ];
            for (const field of backupFields) {
                if (field && typeof field === 'string' && field.includes('@s.whatsapp.net') && !field.includes('@lid')) {
                    rawJid = field;
                    break;
                }
            }
        }

        // Limpa o JID
        const chatLimpo = rawJid.split('@')[0].replace(/\D/g, "");
        const messageText = getMessageText(body);

        console.log(`🔎 Nova mensagem de: ${chatLimpo} | Texto: "${messageText}" | fromMe: ${fromMe}`);

        if (!chatLimpo || !messageText) {
            return res.status(200).send('Ignorado (Falta dados ou eh midia)');
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
                    console.log(`🛑 ADMIN PAUSOU O BOT PARA O NÚMERO: ${alvoLimpo}`);
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
                    console.log(`🟢 ADMIN REATIVOU O BOT PARA O NÚMERO: ${alvoLimpo}`);
                    await sendMessage(chatLimpo, `🟢 Bot reativado para ${alvoLimpo}.`);
                }
                return res.status(200).send('Admin');
            }
        }

        // --- ZONA DE PAUSA E HUMANO ---
        if (conversasPausadas.has(chatLimpo)) {
            console.log(`🛑 Abortado: A conversa com ${chatLimpo} está pausada pelo administrador.`);
            return res.status(200).send('Pausado');
        }

        if (fromMe) {
            if (ehEcoDoBot(chatLimpo, messageText)) {
                return res.status(200).send('Ignorado (eco do bot)');
            }
            pauseChat(chatLimpo);
            clearHistory(chatLimpo);
            console.log(`🛑 PAUSA AUTOMATICA: O atendente humano assumiu a conversa com ${chatLimpo}`);
            return res.status(200).send('Ignorado (Mensagem do proprio dono)');
        }

        // --- ZONA DA IA ---
        console.log(`✅ Cliente ${chatLimpo} diz: "${messageText}" -> Enviando para a IA...`);

        const aiResponse = await getGroqResponse(messageText, chatLimpo);
        
        console.log(`🧠 IA Respondeu: ${aiResponse}`);
        registrarEnvioBot(chatLimpo, aiResponse);
        
        console.log(`🚀 Solicitando envio para a W-API com destino: ${chatLimpo}`);
        const sendResult = await sendMessage([chatLimpo], aiResponse);
        
        res.status(200).send('OK');

    } catch (error) {
        console.error('❌ ERRO FATAL no processamento do Webhook:', error);
        res.status(200).send('Erro');
    }
});

app.listen(PORT, () => {
    console.log(`🚀 Servidor rodando na porta ${PORT}`);
    console.log(`🧠 Memória ativada para conversas contínuas.`);
});