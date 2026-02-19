const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env'), override: true });
const express = require('express');
// Importamos também o clearHistory para limpar memória quando der !pare ou !volte
const {
    getGroqResponse,
    clearHistory,
    getStudentSupportResponse,
    clearStudentHistory
} = require('./services/ai');
const { sendMessage } = require('./services/wapi');

const app = express();
const PORT = process.env.PORT || 8080; 

const conversasPausadas = new Set();
const ultimosEnviosBot = new Map();
const mensagensBotIds = new Map();
const lidToPhone = new Map();
const conversationStates = new Map();
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

function normalizeText(value) {
    return String(value || '')
        .trim()
        .toLowerCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '');
}

function getConversationState(chatId) {
    const current = conversationStates.get(chatId);
    if (current) return current;
    return {
        stage: 'NEW',
        cpf: '',
        isStudent: null
    };
}

function saveConversationState(chatId, state) {
    if (!chatId || !state) return;
    conversationStates.set(chatId, state);
}

function resetConversationState(chatId) {
    if (!chatId) return;
    conversationStates.delete(chatId);
    clearHistory(chatId);
    clearStudentHistory(chatId);
}

function extractCpf(text) {
    const match = String(text || '').match(/(\d{3}\.?\d{3}\.?\d{3}-?\d{2})/);
    if (!match) return '';
    return String(match[1]).replace(/\D/g, '');
}

function removeCpfFromText(text) {
    return String(text || '')
        .replace(/(\d{3}\.?\d{3}\.?\d{3}-?\d{2})/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function isValidCPF(cpf) {
    const digits = String(cpf || '').replace(/\D/g, '');
    if (digits.length !== 11) return false;
    if (/^(\d)\1{10}$/.test(digits)) return false;

    const calc = (base, factor) => {
        let total = 0;
        for (const char of base) {
            total += Number(char) * factor;
            factor -= 1;
        }
        const remainder = total % 11;
        return remainder < 2 ? 0 : 11 - remainder;
    };

    const d1 = calc(digits.slice(0, 9), 10);
    const d2 = calc(digits.slice(0, 10), 11);
    return digits.endsWith(`${d1}${d2}`);
}

function detectStudentStatus(text) {
    const normalized = normalizeText(text);
    if (!normalized) return 'unknown';

    const directYes = ['sim', 's', 'yes', 'ja', 'já'];
    const directNo = ['nao', 'não', 'n', 'no'];

    if (directYes.includes(normalized)) return 'student';
    if (directNo.includes(normalized)) return 'lead';

    const noStudent = [
        'nao sou aluno',
        'não sou aluno',
        'nao estudo',
        'não estudo',
        'quero me matricular',
        'novo aluno',
        'nao sou da escola',
        'não sou da escola'
    ];
    const student = [
        'sou aluno',
        'ja sou aluno',
        'já sou aluno',
        'sou estudante',
        'ja estudo',
        'já estudo',
        'aluno da active',
        'estudo na active'
    ];

    if (noStudent.some((item) => normalized.includes(normalizeText(item)))) return 'lead';
    if (student.some((item) => normalized.includes(normalizeText(item)))) return 'student';

    if (/\b(aluno|estudante)\b/.test(normalized) && !normalized.includes('nao')) return 'student';
    return 'unknown';
}

function detectStudentTopic(text) {
    const normalized = normalizeText(text);
    if (!normalized) return 'outro';
    if (/(financeiro|boleto|mensalidade|pagamento|fatura)/.test(normalized)) return 'financeiro';
    if (/(turma|classe)/.test(normalized)) return 'turmas';
    if (/(aula|horario|agenda)/.test(normalized)) return 'aulas';
    if (/(link|meet|zoom|google meet)/.test(normalized)) return 'link';
    if (/(material|apostila|livro)/.test(normalized)) return 'material';
    return 'outro';
}

function hasStudentSupportSignal(text) {
    const topic = detectStudentTopic(text);
    const cpf = extractCpf(text);
    return {
        topic,
        cpf,
        matches: Boolean(cpf) || topic !== 'outro'
    };
}

async function sendBotReply(chatId, chatLimpo, text) {
    const content = String(text || '').trim();
    if (!chatId || !content) return null;

    if (chatLimpo) registrarEnvioBot(chatLimpo, content);
    registrarEnvioBot(chatId, content);

    const sendResult = await sendMessage(chatId, content);
    const sentMessageId =
        sendResult?.key?.id ||
        sendResult?.data?.key?.id ||
        sendResult?.messageId ||
        sendResult?.id ||
        sendResult?.data?.messageId ||
        sendResult?.data?.id;
    registrarMensagemBotId(sentMessageId);
    return sendResult;
}


app.post('/webhook', async (req, res) => {
    try {
        const body = req.body || {};
        const data = body.data || body;

        // 1. BLOQUEIO SILENCIOSO: Ignora recibos de leitura e entrega (limpa o terminal)
        if (body.event === 'webhookStatus' || body.status || data.event === 'webhookStatus') {
            return res.status(200).send('Ignorado (Status de entrega/leitura)');
        }

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

        // Extrator de JID
        let rawJid = data?.key?.remoteJid || body?.key?.remoteJid || data?.remoteJid || body?.remoteJid || body?.sender?.id || body?.phone || body?.from || data?.from;
        
        if (!rawJid || typeof rawJid !== 'string') {
            return res.status(200).send('Ignorado (Sem JID)');
        }

        if (rawJid.includes('@broadcast') || rawJid.includes('status@') || rawJid.includes('@g.us')) {
            return res.status(200).send('Ignorado (Broadcast/Grupo)');
        }

        // Anti-Máscara
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

        const eventType = getEventType(body);
        const eventUpper = String(eventType || "").toUpperCase();
        if (eventUpper === "WEBHOOKSTATUS") {
            const statusFromMe = truthyFlag(body.fromMe);
            if (statusFromMe) {
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
                    console.log("🧾 STATUS META:", {
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
                    if (statusDigits) resetConversationState(statusDigits);
                    console.log(`PAUSA AUTOMATICA (STATUS fromMe): ${statusDigits || pauseTarget}`);
                }
            }
            return res.status(200).send('Status');
        }

        const senderRaw = pickFirstId(
            data.key?.participant,
            data.key?.remoteJid,
            data.remoteJid,
            data.participant,
            data.sender?.id,
            data.sender?.phone,
            body.sender?.id,
            body.sender?.phone,
            body.sender,
            body.author,
            body.participant,
            body.from,
            body.key?.participant
        );
        const sender = toDigits(senderRaw);
        const fromMe =
            truthyFlag(body.fromMe) ||
            truthyFlag(body.key?.fromMe) ||
            truthyFlag(body.data?.fromMe) ||
            truthyFlag(data.fromMe) ||
            truthyFlag(data.key?.fromMe) ||
            truthyFlag(body.sender?.fromMe) ||
            truthyFlag(body.sender?.isMe) ||
            truthyFlag(body.sender?.isOwner);
        const adminMatch =
            sender.includes(NUMERO_ADMIN) ||
            toDigits(extractId(body.author)).includes(NUMERO_ADMIN) ||
            toDigits(extractId(body.participant)).includes(NUMERO_ADMIN) ||
            toDigits(extractId(body.key?.participant)).includes(NUMERO_ADMIN);

        const chatIdDefault = pickFirstId(
            data.key?.remoteJid,
            data.remoteJid,
            data.chatId,
            body.chat?.id,
            body.chatId,
            body.phone,
            body.from,
            body.to,
            body.key?.remoteJid
        );
        const chatId = (fromMe || adminMatch)
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
            : chatIdDefault;
        const messageText = getMessageText(body);

        console.log(`🔎 Nova mensagem de: ${chatLimpo} | Texto: "${messageText}" | fromMe: ${fromMe}`);

        // --- ZONA DE PAUSA AUTOMÁTICA (HUMANO ASSUMIU) ---
        // Agora vem ANTES de verificar se a mensagem tem texto!
        if (fromMe) {
            if (messageText && ehEcoDoBot(chatLimpo, messageText)) {
                return res.status(200).send('Ignorado (eco do bot)');
            }
            // Se chegou aqui, foi você quem mandou a mensagem (texto, áudio, foto, etc)
            pauseChat(chatLimpo);
            clearHistory(chatLimpo);
            console.log(`🛑 PAUSA AUTOMÁTICA: O atendente humano assumiu a conversa com ${chatLimpo}. O bot ficará mudo para este cliente.`);
            return res.status(200).send('Ignorado (Mensagem do proprio dono)');
        }

        // Se o CLIENTE mandou algo sem texto (áudio, foto sem legenda), a IA ignora
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
                    conversasPausadas.add(alvoLimpo + "@c.us");
                    conversasPausadas.add(alvoLimpo + "@s.whatsapp.net");
                    
                    // Limpa a memória da IA para quando voltar, voltar "zerado" ou manter, você decide.
                    // resetConversationState(alvoLimpo); 
                    
                    console.log(`🛑 ADMIN PAUSOU: ${alvoLimpo}`);
                    await sendBotReply(chatId, chatLimpo, `Bot pausado para ${alvoLimpo}.`);
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
                    
                    // Limpa memória para começar conversa nova limpa
                    resetConversationState(alvoLimpo); 

                    console.log(`🟢 ADMIN REATIVOU: ${alvoLimpo}`);
                    await sendBotReply(chatId, chatLimpo, `Bot reativado para ${alvoLimpo}.`);
                }
                return res.status(200).send('Admin');
            }
        }

        // --- ZONA DE CHECAGEM DE PAUSA ---
        if (conversasPausadas.has(chatLimpo)) {
            console.log(`🛑 Abortado: A conversa com ${chatLimpo} está pausada pelo administrador.`);
            return res.status(200).send('Pausado');
        }

        // --- ZONA DA IA ---
        console.log(`✅ Cliente ${chatLimpo} diz: "${messageText}" -> Enviando para a IA...`);

            if (!PAUSA_AUTOMATICA_ADMIN_ONLY || adminMatch) {
                pauseChat(chatId);
                resetConversationState(chatLimpo);
                console.log(`PAUSA AUTOMATICA (ASSUMIDO): ${chatLimpo}`);
                return res.status(200).send('Pausado (assumido)');
            }
        }

        // --- ONBOARDING E ROTEAMENTO ALUNO / NAO ALUNO ---
        let state = getConversationState(chatLimpo);

        if (!adminMatch && state.stage === 'NEW') {
            state.stage = 'AWAITING_PROFILE';
            saveConversationState(chatLimpo, state);
            await sendBotReply(
                chatId,
                chatLimpo,
                [
                    'Ola! Seja bem-vindo(a) a Active.',
                    'Para eu te atender melhor, me diga:',
                    '1) Seu nome',
                    '2) Se voce ja e aluno(a) da escola (sim/nao)',
                    '3) O que voce precisa hoje'
                ].join('\n')
            );
            return res.status(200).send('Onboarding');
        }

        if (!adminMatch && state.stage === 'AWAITING_PROFILE') {
            const studentStatus = detectStudentStatus(texto);
            const studentSignal = hasStudentSupportSignal(texto);
            const shouldRouteStudent = studentStatus === 'student' || studentSignal.matches;

            if (shouldRouteStudent) {
                state.stage = 'STUDENT_AWAITING_CPF';
                state.isStudent = true;
                saveConversationState(chatLimpo, state);
            } else if (studentStatus === 'lead') {
                state.stage = 'LEAD_READY';
                state.isStudent = false;
                saveConversationState(chatLimpo, state);
            } else {
                await sendBotReply(
                    chatId,
                    chatLimpo,
                    'Para continuar, confirme se voce ja e aluno(a) da Active. Responda: "sou aluno" ou "nao sou aluno".'
                );
                return res.status(200).send('Perfil');
            }
        }

        if (!adminMatch && state.stage === 'LEAD_READY') {
            const studentStatus = detectStudentStatus(texto);
            const studentSignal = hasStudentSupportSignal(texto);
            if (studentStatus === 'student' || studentSignal.matches) {
                state.stage = 'STUDENT_AWAITING_CPF';
                state.isStudent = true;
                saveConversationState(chatLimpo, state);
            }
        }

        if (!adminMatch && (state.stage === 'STUDENT_AWAITING_CPF' || state.stage === 'STUDENT_READY')) {
            let studentRequest = texto;

            if (!state.cpf) {
                const cpf = extractCpf(texto);
                if (!cpf) {
                    await sendBotReply(
                        chatId,
                        chatLimpo,
                        'Preciso do CPF do aluno para continuar o atendimento. Envie os 11 digitos.'
                    );
                    return res.status(200).send('CPF pendente');
                }

                if (!isValidCPF(cpf)) {
                    await sendBotReply(chatId, chatLimpo, 'CPF invalido. Verifique e envie novamente.');
                    return res.status(200).send('CPF invalido');
                }

                state.cpf = cpf;
                state.stage = 'STUDENT_READY';
                saveConversationState(chatLimpo, state);

                studentRequest = removeCpfFromText(texto);
                if (!studentRequest) {
                    await sendBotReply(
                        chatId,
                        chatLimpo,
                        [
                            'CPF confirmado com sucesso.',
                            'Agora me diga o que voce precisa:',
                            '- financeiro',
                            '- turmas',
                            '- aulas',
                            '- link',
                            '- material',
                            '- ou outro assunto da Active'
                        ].join('\n')
                    );
                    return res.status(200).send('CPF ok');
                }
            }

            const topic = detectStudentTopic(studentRequest);
            const supportResponse = await getStudentSupportResponse(studentRequest, chatLimpo, {
                cpfConfirmado: true,
                assunto: topic
            });

            await sendBotReply(chatId, chatLimpo, supportResponse);
            return res.status(200).send('Aluno atendido');
        }

        // --- ZONA DA IA (NAO ALUNO / COMERCIAL) ---
        console.log(`Cliente ${chatLimpo} disse: "${messageText}" -> IA comercial`);
        const aiResponse = await getGroqResponse(messageText, chatLimpo);
        await sendBotReply(chatId, chatLimpo, aiResponse);

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



