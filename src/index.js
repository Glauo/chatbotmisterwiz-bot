const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env'), override: true });
const express = require('express');
// Importamos tambÃ©m o clearHistory para limpar memÃ³ria quando der !pare ou !volte
const { getGroqResponse, clearHistory } = require('./services/ai'); 
const { sendMessage } = require('./services/wapi');

const app = express();
const PORT = process.env.PORT || 3000;

const conversasPausadas = new Set();
const ultimosEnviosBot = new Map();
const mensagensBotIds = new Map();
const lidToPhone = new Map();
const processedMessageIds = new Map(); // Deduplicação por message ID
const DEDUP_TTL_MS = 60 * 1000; // 60 segundos de janela de deduplicação
const BOT_ECHO_WINDOW_MS = 15000;
const BOT_MSG_ID_TTL_MS = 5 * 60 * 1000;
const NUMERO_ADMIN = "5516993804499"; 
const PHONE_COUNTRY_PREFIX = toDigits(process.env.PHONE_COUNTRY_PREFIX || "55");
const BOT_SELF_NUMBER = toDigits(
    process.env.BOT_SELF_NUMBER ||
    process.env.WHATSAPP_BOT_NUMBER ||
    process.env.INSTANCE_PHONE ||
    process.env.OWNER_NUMBER ||
    ""
);
// Safer default: only pause chats manually/admin unless explicitly disabled.
const PAUSA_AUTOMATICA_ADMIN_ONLY = String(process.env.PAUSA_AUTOMATICA_ADMIN_ONLY || "true").toLowerCase() !== "false";
// Optional guard for advanced takeover flows; disabled by default.
const AUTO_PAUSE_ON_STATUS = String(process.env.AUTO_PAUSE_ON_STATUS || "").toLowerCase() === "true";
const DEBUG_WEBHOOK = String(process.env.DEBUG_WEBHOOK || "").toLowerCase() === "true";

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.get('/', (req, res) => res.send('ðŸ¤– Bot com MemÃ³ria ON!'));
app.get('/healthz', (req, res) => res.status(200).send('ok'));

function toDigits(value) {
    return String(value || "").replace(/\D/g, "");
}

function extractId(value) {
    if (!value) return "";
    if (typeof value === "string" || typeof value === "number") return String(value);
    if (typeof value === "object") {
        return (
            value.id ||
            value.user ||
            value.phone ||
            value.jid ||
            value.remoteJid ||
            value.chatId ||
            value._serialized ||
            ""
        );
    }
    return "";
}

function pickFirstId(...values) {
    for (const v of values) {
        const id = extractId(v);
        if (id) return id;
    }
    return "";
}

function pickFirstString(...values) {
    for (const v of values) {
        if (typeof v === "string" && v.trim()) return v;
    }
    return "";
}

function getEventType(body) {
    if (!body || typeof body !== "object") return "";
    return pickFirstString(
        body.event,
        body.type,
        body.eventType,
        body.action,
        body.data?.event,
        body.data?.type,
        body.data?.eventType,
        body.data?.action
    );
}

function getPayloadData(body) {
    if (!body || typeof body !== "object") return {};
    const data = body.data && typeof body.data === "object" ? body.data : body;
    if (data?.messages && Array.isArray(data.messages) && data.messages.length) {
        return data.messages[0];
    }
    if (data?.message && (data.message.key || data.message.message)) {
        return data.message;
    }
    return data;
}

function getMessageText(body) {
    const data = getPayloadData(body);
    const msg = data.message || data.msgContent || body.msgContent || data;
    return pickFirstString(
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
    );
}

function truthyFlag(value) {
    if (value === true || value === 1 || value === "1") return true;
    if (typeof value === "string") return value.toLowerCase() === "true";
    return false;
}

function normalizeChatId(value) {
    const raw = String(value || "");
    const base = raw.split(":")[0];
    const digits = toDigits(base);
    return { raw, base, digits };
}

function normalizeLid(value) {
    const raw = String(value || "");
    const base = raw.split(":")[0];
    return base.endsWith("@lid") ? base : "";
}

function rememberLidMapping(lid, phone) {
    const lidBase = normalizeLid(lid);
    const phoneDigits = toDigits(phone);
    if (lidBase && phoneDigits) {
        lidToPhone.set(lidBase, phoneDigits);
    }
}

function resolveLidToPhone(value) {
    const lidBase = normalizeLid(value);
    if (!lidBase) return "";
    return lidToPhone.get(lidBase) || "";
}

function isLikelyPhoneDigits(value) {
    const digits = toDigits(value);
    if (!(digits.length >= 10 && digits.length <= 15)) return false;
    if (PHONE_COUNTRY_PREFIX && !digits.startsWith(PHONE_COUNTRY_PREFIX)) return false;
    return true;
}

function resolveBestPhoneId(...values) {
    for (const v of values) {
        const id = extractId(v);
        if (!id) continue;
        const mapped = resolveLidToPhone(id);
        if (isLikelyPhoneDigits(mapped)) return mapped;
        const base = String(id).split(":")[0];
        // @lid não é número de WhatsApp real (a menos que já esteja mapeado).
        if (base.endsWith("@lid")) continue;
        // Se tiver sufixo, aceitar apenas IDs clássicos do WhatsApp.
        if (base.includes("@") && !base.endsWith("@s.whatsapp.net") && !base.endsWith("@c.us")) {
            continue;
        }
        const direct = toDigits(base);
        if (isLikelyPhoneDigits(direct)) return direct;
    }
    return "";
}

function buildSelfNumberSet(body, data, fromMe) {
    const set = new Set();
    if (BOT_SELF_NUMBER) set.add(BOT_SELF_NUMBER);
    const instanceHints = [
        body?.instance?.owner,
        body?.instance?.number,
        body?.instance?.wuid,
        body?.me?.id,
        body?.me?.phone
    ];
    for (const hint of instanceHints) {
        const digits = toDigits(extractId(hint));
        if (isLikelyPhoneDigits(digits)) set.add(digits);
    }
    if (fromMe) {
        const senderHint = resolveBestPhoneId(
            body?.sender?.id,
            body?.sender?.phone,
            body?.sender,
            data?.sender?.id,
            data?.sender?.phone,
            body?.from
        );
        if (senderHint) set.add(senderHint);
    }
    return set;
}

function pickInboundChatId(candidates, selfNumbers) {
    for (const candidate of candidates) {
        const id = extractId(candidate);
        if (!id) continue;
        const idStr = String(id);
        if (idStr.includes("@broadcast") || idStr.includes("@g.us")) continue;

        const mapped = resolveLidToPhone(id);
        const base = idStr.split(":")[0];
        // Não usar @lid sem mapeamento prévio.
        if (!mapped && base.endsWith("@lid")) continue;
        // Se tiver sufixo, aceitar apenas IDs clássicos do WhatsApp.
        if (!mapped && base.includes("@") && !base.endsWith("@s.whatsapp.net") && !base.endsWith("@c.us")) continue;

        const chosen = mapped || id;
        const digits = toDigits(String(chosen).split(":")[0]);

        if (!isLikelyPhoneDigits(digits)) continue;
        if (selfNumbers.has(digits)) continue;

        return chosen;
    }
    return "";
}

function pauseChat(chatId) {
    if (!chatId) return;
    const { raw, base, digits } = normalizeChatId(chatId);
    if (digits) {
        conversasPausadas.add(digits);
        conversasPausadas.add(digits + "@c.us");
        conversasPausadas.add(digits + "@s.whatsapp.net");
    }
    if (raw) conversasPausadas.add(raw);
    if (base) conversasPausadas.add(base);
}

function cleanupMensagemBotIds() {
    const now = Date.now();
    for (const [id, ts] of mensagensBotIds.entries()) {
        if (now - ts > BOT_MSG_ID_TTL_MS) mensagensBotIds.delete(id);
    }
}

function registrarMensagemBotId(id) {
    if (!id) return;
    mensagensBotIds.set(String(id), Date.now());
    cleanupMensagemBotIds();
}

function isMensagemBotId(id) {
    if (!id) return false;
    cleanupMensagemBotIds();
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
    const dentroJanela = Date.now() - info.ts <= BOT_ECHO_WINDOW_MS;
    const mesmoTexto = info.texto === texto.trim();
    if (dentroJanela && mesmoTexto) {
        ultimosEnviosBot.delete(chaveChat);
        return true;
    }
    return false;
}


app.post('/webhook', async (req, res) => {
    try {
        const body = req.body || {};
        const data = getPayloadData(body);
        if (DEBUG_WEBHOOK) {
            try {
                const raw = JSON.stringify(body, null, 2);
                const truncated = raw.length > 8000 ? raw.slice(0, 8000) + "\n...<truncated>" : raw;
                console.log("ðŸ§¾ WEBHOOK RAW:", truncated);
            } catch (e) {
                console.log("ðŸ§¾ WEBHOOK RAW: <erro ao serializar>");
            }
        }

        const eventType = getEventType(body);
        const eventUpper = String(eventType || "").toUpperCase();
        console.log(`[WEBHOOK] event=${eventUpper || 'UNKNOWN'}`);

        // === DEDUPLICAÇÃO POR MESSAGE ID ===
        const messageId = data?.key?.id || data?.id || body?.key?.id || body?.id || body?.data?.key?.id;
        if (messageId) {
            const now = Date.now();
            // Limpar IDs antigos
            for (const [id, ts] of processedMessageIds.entries()) {
                if (now - ts > DEDUP_TTL_MS) processedMessageIds.delete(id);
            }
            if (processedMessageIds.has(messageId)) {
                console.log(`[DEDUP] Mensagem duplicada ignorada: ${messageId}`);
                return res.status(200).send('Duplicada');
            }
            processedMessageIds.set(messageId, now);
        }
        if (eventUpper === "WEBHOOKSTATUS") {
            const statusFromMe = truthyFlag(body.fromMe);
            if (statusFromMe && AUTO_PAUSE_ON_STATUS) {
                const statusChatId = pickFirstId(
                    body.chat?.id,
                    body.chatId,
                    body.key?.remoteJid,
                    body.to,
                    body.from,
                    body.phone
                );
                const mappedPhone = resolveLidToPhone(statusChatId);
                const statusMessageId = body.messageId || body.id || body.data?.messageId || body.data?.id;
                const knownBot = isMensagemBotId(statusMessageId);
                if (DEBUG_WEBHOOK) {
                    console.log("ðŸ§¾ STATUS META:", {
                        statusMessageId,
                        statusChatId,
                        mappedPhone,
                        knownBot,
                        hasKnownBotIds: mensagensBotIds.size > 0
                    });
                }
                if (statusMessageId && !knownBot) {
                    const pauseTarget = mappedPhone || statusChatId;
                    pauseChat(pauseTarget);
                    const statusDigits = normalizeChatId(pauseTarget).digits;
                    if (statusDigits) clearHistory(statusDigits);
                    console.log(`PAUSA AUTOMATICA (STATUS fromMe): ${statusDigits || pauseTarget}`);
                }
            }
            return res.status(200).send('Status');
        }

        const senderRaw = pickFirstId(
            body.sender?.id,
            body.sender?.phone,
            body.sender,
            body.from,
            body.phone,
            body.participant,
            body.key?.participant,
            body.key?.remoteJid,
            body.key?.participantPn,
            body.key?.remoteJidPn,
            data.key?.participant,
            data.key?.remoteJid,
            data.key?.participantPn,
            data.key?.remoteJidPn,
            data.remoteJid,
            data.participant,
            data.sender?.id,
            data.sender?.phone,
            body.author,
            data.chatId,
            body.chatId
        );
        const senderResolved = resolveBestPhoneId(
            body.sender?.id,
            body.sender?.phone,
            body.sender,
            body.from,
            body.phone,
            body.participant,
            body.key?.participant,
            body.key?.remoteJid,
            body.key?.participantPn,
            body.key?.remoteJidPn,
            data.key?.participant,
            data.key?.remoteJid,
            data.key?.participantPn,
            data.key?.remoteJidPn,
            data.remoteJid,
            data.participant,
            data.sender?.id,
            data.sender?.phone,
            body.author,
            data.chatId,
            body.chatId
        );
        const sender = senderResolved || toDigits(senderRaw);
        const fromMe =
            truthyFlag(body.fromMe) ||
            truthyFlag(body.key?.fromMe) ||
            truthyFlag(body.data?.fromMe) ||
            truthyFlag(data.fromMe) ||
            truthyFlag(data.key?.fromMe) ||
            truthyFlag(body.sender?.fromMe) ||
            truthyFlag(body.sender?.isMe) ||
            truthyFlag(body.sender?.isOwner);
        const selfNumbers = buildSelfNumberSet(body, data, fromMe);
        const adminMatch =
            sender.includes(NUMERO_ADMIN) ||
            toDigits(extractId(body.author)).includes(NUMERO_ADMIN) ||
            toDigits(extractId(body.participant)).includes(NUMERO_ADMIN) ||
            toDigits(extractId(body.key?.participant)).includes(NUMERO_ADMIN);

        const chatIdDefault = pickFirstId(
            body.sender?.id,
            body.sender?.phone,
            body.sender,
            body.from,
            body.phone,
            body.participant,
            body.key?.participant,
            body.key?.remoteJid,
            body.key?.participantPn,
            body.key?.remoteJidPn,
            data.key?.remoteJid,
            data.key?.remoteJidPn,
            data.remoteJid,
            data.chatId,
            body.chat?.id,
            body.chatId,
            body.to,
            data.key?.participant,
            data.key?.participantPn,
            data.participant
        );
        // For inbound messages, reply to the sender chat.
        // For messages sent by this number (fromMe), use "to/phone" as destination.
        let chatId = fromMe
            ? pickFirstId(
                body.to,
                body.phone,
                data.key?.remoteJid,
                body.chat?.id,
                body.chatId,
                body.key?.remoteJid,
                body.from,
                chatIdDefault
            )
            : pickInboundChatId([
                body.sender?.id,
                body.sender?.phone,
                body.sender,
                body.from,
                body.phone,
                body.participant,
                body.key?.participant,
                body.key?.remoteJid,
                body.key?.participantPn,
                body.key?.remoteJidPn,
                data.key?.remoteJid,
                data.key?.remoteJidPn,
                data.remoteJid,
                data.chatId,
                body.chat?.id,
                body.chatId,
                data.key?.participant,
                data.key?.participantPn,
                data.participant,
                senderRaw,
                body.author
            ], selfNumbers);
        if (!fromMe && !chatId && senderResolved && !selfNumbers.has(senderResolved)) {
            chatId = senderResolved;
        } else if (!fromMe) {
            const mappedChat = resolveLidToPhone(chatId);
            if (mappedChat) chatId = mappedChat;
        }
        const messageText = getMessageText(body);

        if (!chatId || !messageText) {
            console.log('[WEBHOOK] ignored (missing chatId/text)', {
                event: eventUpper || 'UNKNOWN',
                chatId,
                hasText: Boolean(messageText)
            });
            return res.status(200).send('Ignorado');
        }

        const texto = messageText.trim();
        const comando = texto.toLowerCase().split(" ")[0];
        const chatLimpo = (sender && !selfNumbers.has(sender)) ? sender : toDigits(chatId); // ID da conversa para memÃ³ria

        // Proteção: nunca responder para o próprio número do bot.
        if (!fromMe && chatLimpo && selfNumbers.has(chatLimpo)) {
            if (DEBUG_WEBHOOK) {
                console.log(`[WEBHOOK] ignorado (chat do próprio bot): ${chatLimpo}`);
            }
            return res.status(200).send('Ignorado (self)');
        }

        rememberLidMapping(body.sender?.senderLid, senderRaw);
        rememberLidMapping(body.sender?.senderLid, chatId);
        rememberLidMapping(body.chat?.id, chatId);
        rememberLidMapping(data.key?.remoteJid, chatId);
        if (DEBUG_WEBHOOK) {
            console.log("ðŸ§¾ WEBHOOK META:", {
                fromMe,
                adminMatch,
                senderRaw,
                sender,
                chatId,
                chatIdDefault,
                to: extractId(body.to),
                phone: extractId(body.phone),
                from: extractId(body.from),
                author: extractId(body.author),
                participant: extractId(body.participant),
                remoteJid: extractId(body.key?.remoteJid),
                hasMessage: Boolean(messageText)
            });
        }
        if (fromMe) {
            console.log("ðŸ§­ ASSUMIU? META:", {
                fromMe,
                adminMatch,
                senderRaw,
                sender,
                chatId,
                chatIdDefault,
                to: extractId(body.to),
                phone: extractId(body.phone),
                from: extractId(body.from),
                author: extractId(body.author),
                participant: extractId(body.participant),
                remoteJid: extractId(body.key?.remoteJid)
            });
        }

        // --- ZONA DE COMANDO (Admin) ---
        if (adminMatch) {
            if (comando === '!silencio' || comando === '!pare') {
                const alvo = texto.split(" ")[1]; 
                if (alvo) {
                    const alvoLimpo = alvo.replace(/\D/g, "");
                    conversasPausadas.add(alvoLimpo); 
                    conversasPausadas.add(alvoLimpo + "@c.us");
                    conversasPausadas.add(alvoLimpo + "@s.whatsapp.net");
                    
                    // Limpa a memÃ³ria da IA para quando voltar, voltar "zerado" ou manter, vocÃª decide.
                    // clearHistory(alvoLimpo); 
                    
                    console.log(`ðŸ›‘ ADMIN PAUSOU: ${alvoLimpo}`);
                    await sendMessage(chatId, `ðŸ›‘ Bot pausado para ${alvoLimpo}.`);
                }
                return res.status(200).send('Admin');
            }

            if (comando === '!volte') {
                const alvo = texto.split(" ")[1];
                if (alvo) {
                    const alvoLimpo = alvo.replace(/\D/g, "");
                    conversasPausadas.delete(alvoLimpo);
                    conversasPausadas.delete(alvoLimpo + "@c.us");
                    conversasPausadas.delete(alvoLimpo + "@s.whatsapp.net");
                    
                    // Limpa memÃ³ria para comeÃ§ar conversa nova limpa
                    clearHistory(alvoLimpo); 

                    console.log(`ðŸŸ¢ ADMIN REATIVOU: ${alvoLimpo}`);
                    await sendMessage(chatId, `ðŸŸ¢ Bot reativado para ${alvoLimpo}.`);
                }
                return res.status(200).send('Admin');
            }
        }

        // --- ZONA DE PAUSA ---
        if (conversasPausadas.has(chatLimpo) || conversasPausadas.has(chatId)) {
            if (DEBUG_WEBHOOK) {
                console.log(`[WEBHOOK] chat pausado: ${chatLimpo || chatId}`);
            }
            return res.status(200).send('Pausado');
        }

        if (fromMe) {
            const ecoBot = ehEcoDoBot(chatLimpo, messageText) || ehEcoDoBot(chatId, messageText);
            if (ecoBot) {
                return res.status(200).send('Ignorado (eco bot)');
            }

            // Pausa automática: quando o admin envia uma mensagem manualmente,
            // o bot para de responder naquele chat até que o admin use !volte
            // CORREÇÃO: Só pausa se for o admin E a flag estiver ativa
            if (adminMatch && PAUSA_AUTOMATICA_ADMIN_ONLY) {
                pauseChat(chatId);
                clearHistory(chatLimpo);
                console.log(`🛑 PAUSA AUTOMATICA (ADMIN ASSUMIU): ${chatLimpo}`);
                return res.status(200).send('Pausado (assumido)');
            }
        }

        // --- ZONA DA IA (AGORA COM MEMÃ“RIA) ---
        console.log(`âœ… Cliente ${chatLimpo} disse: "${messageText}"`);

        // MUDANÃ‡A AQUI: Passamos o chatLimpo (ID do cliente) para a memÃ³ria funcionar
        const aiResponse = await getGroqResponse(messageText, chatLimpo);
        
        console.log(`ðŸ§  IA: ${aiResponse}`);
        registrarEnvioBot(chatLimpo, aiResponse);
        registrarEnvioBot(chatId, aiResponse);
        const replyTargets = [
            chatId,
            data.key?.remoteJid,
            body.key?.remoteJid,
            body.from,
            body.phone,
            body.sender?.id,
            body.sender?.phone,
            data.sender?.id,
            data.sender?.phone,
            senderRaw
        ].filter(Boolean).filter((target) => {
            const d = toDigits(String(target).split(":")[0]);
            return !d || !selfNumbers.has(d);
        });
        const sendResult = await sendMessage(replyTargets, aiResponse);
        const sentMessageId =
            sendResult?.key?.id ||
            sendResult?.data?.key?.id ||
            sendResult?.messageId ||
            sendResult?.id ||
            sendResult?.data?.messageId ||
            sendResult?.data?.id;
        registrarMensagemBotId(sentMessageId);

        res.status(200).send('OK');

    } catch (error) {
        console.error('âŒ Erro:', error);
        res.status(200).send('Erro');
    }
});

app.listen(PORT, () => {
    console.log(`ðŸš€ Servidor rodando na porta ${PORT}`);
    console.log(`ðŸ§  MemÃ³ria ativada para conversas contÃ­nuas.`);
});


