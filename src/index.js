const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env'), override: true });
const express = require('express');
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
const processedMessageIds = new Map();
const conversationStates = new Map();

const DEDUP_TTL_MS = 60 * 1000;
const BOT_ECHO_WINDOW_MS = 15000;

const NUMERO_ADMIN = '5516993804499';
const DEBUG_WEBHOOK = String(process.env.DEBUG_WEBHOOK || 'true').toLowerCase() === 'true';

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.get('/', (req, res) => res.send('Bot Mister Wiz online'));
app.get('/healthz', (req, res) => res.status(200).send('ok'));

function getMessageText(body) {
    if (!body || typeof body !== 'object') return '';

    const data = body.data && typeof body.data === 'object' ? body.data : body;
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

    for (const value of candidates) {
        if (typeof value === 'string' && value.trim()) return value.trim();
    }

    return '';
}

function truthyFlag(value) {
    if (value === true || value === 1 || value === '1') return true;
    if (typeof value === 'string') return value.toLowerCase() === 'true';
    return false;
}

function normalizeText(value) {
    return String(value || '')
        .trim()
        .toLowerCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '');
}

function pauseChat(chatId) {
    if (!chatId) return;
    conversasPausadas.add(chatId);
}

function registrarEnvioBot(chatId, texto) {
    if (!chatId || !texto) return;
    ultimosEnviosBot.set(chatId, { texto: String(texto).trim(), ts: Date.now() });
}

function ehEcoDoBot(chatId, texto) {
    if (!chatId || !texto) return false;

    const info = ultimosEnviosBot.get(chatId);
    if (!info) return false;

    if (Date.now() - info.ts <= BOT_ECHO_WINDOW_MS && info.texto === String(texto).trim()) {
        ultimosEnviosBot.delete(chatId);
        return true;
    }

    return false;
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

    const directYes = ['sim', 's', 'yes', 'ja', 'sou aluno', 'aluno'];
    const directNo = ['nao', 'n', 'no', 'nao sou aluno'];

    if (directYes.includes(normalized)) return 'student';
    if (directNo.includes(normalized)) return 'lead';

    const noStudent = [
        'nao sou aluno',
        'nao estudo',
        'quero me matricular',
        'novo aluno',
        'nao sou da escola'
    ];

    const student = [
        'sou aluno',
        'ja sou aluno',
        'sou estudante',
        'ja estudo',
        'aluno da active',
        'estudo na active'
    ];

    if (noStudent.some((item) => normalized.includes(item))) return 'lead';
    if (student.some((item) => normalized.includes(item))) return 'student';

    return 'unknown';
}

function detectStudentTopic(text) {
    const normalized = normalizeText(text);
    if (!normalized) return 'outro';

    if (/(financeiro|boleto|mensalidade|pagamento|fatura|cobranca)/.test(normalized)) return 'financeiro';
    if (/(atendimento|suporte|secretaria|auxilio|auxiliar|ajuda)/.test(normalized)) return 'atendimento';
    if (/(coordenacao|coordenador|coordena|cordenacao|cordenador)/.test(normalized)) return 'coordenacao';
    if (/(turma|classe)/.test(normalized)) return 'turmas';
    if (/(aula|horario|agenda)/.test(normalized)) return 'aulas';
    if (/(link|meet|zoom|teams|sala virtual)/.test(normalized)) return 'link';
    if (/(material|apostila|livro|conteudo)/.test(normalized)) return 'material';

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

async function sendBotReply(chatId, text) {
    const content = String(text || '').trim();
    if (!chatId || !content) return;

    registrarEnvioBot(chatId, content);
    await sendMessage([chatId], content);
}

function cleanupProcessedIds() {
    const now = Date.now();
    for (const [id, ts] of processedMessageIds.entries()) {
        if (now - ts > DEDUP_TTL_MS) processedMessageIds.delete(id);
    }
}

app.post('/webhook', async (req, res) => {
    try {
        const body = req.body || {};
        const data = body.data || body;

        if (body.event === 'webhookStatus' || body.status || data.event === 'webhookStatus') {
            return res.status(200).send('Ignorado (status)');
        }

        if (DEBUG_WEBHOOK) {
            console.log('WEBHOOK RAW START');
            console.log(JSON.stringify(body, null, 2).slice(0, 3000));
            console.log('WEBHOOK RAW END');
        }

        const messageId =
            data?.key?.id ||
            data?.id ||
            body?.key?.id ||
            body?.id ||
            body?.data?.key?.id ||
            body?.messageId;

        if (messageId) {
            cleanupProcessedIds();
            if (processedMessageIds.has(messageId)) {
                return res.status(200).send('Duplicada');
            }
            processedMessageIds.set(messageId, Date.now());
        }

        const fromMe =
            truthyFlag(body.fromMe) ||
            truthyFlag(body.key?.fromMe) ||
            truthyFlag(data.fromMe) ||
            truthyFlag(data.key?.fromMe);

        let rawJid =
            data?.key?.remoteJid ||
            body?.key?.remoteJid ||
            data?.remoteJid ||
            body?.remoteJid ||
            body?.sender?.id ||
            body?.phone ||
            body?.from ||
            data?.from;

        if (!rawJid || typeof rawJid !== 'string') {
            return res.status(200).send('Ignorado (sem jid)');
        }

        if (rawJid.includes('@broadcast') || rawJid.includes('status@') || rawJid.includes('@g.us')) {
            return res.status(200).send('Ignorado (broadcast/grupo)');
        }

        if (rawJid.includes('@lid') || rawJid.includes('@tampa') || !rawJid.includes('@')) {
            const backupFields = [
                data?.key?.participant,
                body?.key?.participant,
                data?.sender,
                body?.sender,
                data?.participant,
                body?.participant
            ];
            for (const field of backupFields) {
                if (typeof field === 'string' && field.includes('@s.whatsapp.net') && !field.includes('@lid')) {
                    rawJid = field;
                    break;
                }
            }
        }

        const chatLimpo = rawJid.split('@')[0].replace(/\D/g, '');
        const messageText = getMessageText(body);

        if (DEBUG_WEBHOOK) {
            console.log(`Mensagem de ${chatLimpo} | fromMe=${fromMe} | texto="${messageText}"`);
        }

        if (fromMe) {
            if (messageText && ehEcoDoBot(chatLimpo, messageText)) {
                return res.status(200).send('Ignorado (eco do bot)');
            }

            pauseChat(chatLimpo);
            resetConversationState(chatLimpo);
            return res.status(200).send('Ignorado (mensagem do proprio dono)');
        }

        if (!chatLimpo || !messageText) {
            return res.status(200).send('Ignorado (sem dados ou midia)');
        }

        const texto = messageText.trim();
        const comando = normalizeText(texto).split(' ')[0];
        const adminMatch = chatLimpo === NUMERO_ADMIN;

        if (adminMatch) {
            if (comando === '!silencio' || comando === '!pare') {
                const alvo = texto.split(' ')[1];
                if (alvo) {
                    const alvoLimpo = alvo.replace(/\D/g, '');
                    pauseChat(alvoLimpo);
                    await sendBotReply(chatLimpo, `Bot pausado para ${alvoLimpo}.`);
                }
                return res.status(200).send('Admin');
            }

            if (comando === '!volte') {
                const alvo = texto.split(' ')[1];
                if (alvo) {
                    const alvoLimpo = alvo.replace(/\D/g, '');
                    conversasPausadas.delete(alvoLimpo);
                    resetConversationState(alvoLimpo);
                    await sendBotReply(chatLimpo, `Bot reativado para ${alvoLimpo}.`);
                }
                return res.status(200).send('Admin');
            }
        }

        if (conversasPausadas.has(chatLimpo)) {
            return res.status(200).send('Pausado');
        }

        let state = getConversationState(chatLimpo);

        if (!adminMatch && state.stage === 'NEW') {
            state.stage = 'AWAITING_PROFILE';
            saveConversationState(chatLimpo, state);

            await sendBotReply(
                chatLimpo,
                [
                    'Ola! Seja bem-vindo(a) a Mister Wiz.',
                    'Antes de continuar, me confirme: voce e aluno(a) da escola? (sim/nao)',
                    'Se quiser, ja me diga seu nome e o que voce precisa hoje.'
                ].join('\n')
            );

            return res.status(200).send('Onboarding');
        }

        if (!adminMatch && state.stage === 'AWAITING_PROFILE') {
            const studentStatus = detectStudentStatus(texto);
            const studentSignal = hasStudentSupportSignal(texto);

            if (studentStatus === 'student' || studentSignal.matches) {
                state.stage = 'STUDENT_AWAITING_CPF';
                state.isStudent = true;
                saveConversationState(chatLimpo, state);

                await sendBotReply(
                    chatLimpo,
                    [
                        'Perfeito. Como voce e aluno(a), preciso validar seu CPF para liberar o atendimento.',
                        'Envie o CPF com 11 digitos para continuar.'
                    ].join('\n')
                );
                return res.status(200).send('Aluno confirmado');
            }

            if (studentStatus === 'lead') {
                state.stage = 'LEAD_READY';
                state.isStudent = false;
                saveConversationState(chatLimpo, state);
            } else {
                await sendBotReply(
                    chatLimpo,
                    'Para continuar, responda: "sou aluno" ou "nao sou aluno".'
                );
                return res.status(200).send('Aguardando perfil');
            }
        }

        if (!adminMatch && state.stage === 'LEAD_READY') {
            const studentStatus = detectStudentStatus(texto);
            const studentSignal = hasStudentSupportSignal(texto);

            if (studentStatus === 'student' || studentSignal.matches) {
                state.stage = 'STUDENT_AWAITING_CPF';
                state.isStudent = true;
                saveConversationState(chatLimpo, state);
                await sendBotReply(chatLimpo, 'Entendido. Envie o CPF do aluno (11 digitos) para eu continuar.');
                return res.status(200).send('Aluno detectado no lead');
            }
        }

        if (!adminMatch && (state.stage === 'STUDENT_AWAITING_CPF' || state.stage === 'STUDENT_READY')) {
            let studentRequest = texto;

            if (!state.cpf) {
                const cpf = extractCpf(texto);
                if (!cpf) {
                    await sendBotReply(chatLimpo, 'Preciso do CPF do aluno para continuar. Envie os 11 digitos.');
                    return res.status(200).send('CPF pendente');
                }

                if (!isValidCPF(cpf)) {
                    await sendBotReply(chatLimpo, 'CPF invalido. Verifique e envie novamente.');
                    return res.status(200).send('CPF invalido');
                }

                state.cpf = cpf;
                state.stage = 'STUDENT_READY';
                saveConversationState(chatLimpo, state);

                studentRequest = removeCpfFromText(texto);

                if (!studentRequest) {
                    await sendBotReply(
                        chatLimpo,
                        [
                            'CPF confirmado com sucesso.',
                            'Escolha o que voce precisa agora:',
                            '- financeiro',
                            '- atendimento',
                            '- coordenacao',
                            '- turmas/aulas/links',
                            '- material',
                            '- ou outro assunto da escola'
                        ].join('\n')
                    );
                    return res.status(200).send('CPF validado');
                }
            }

            const topic = detectStudentTopic(studentRequest);
            const supportResponse = await getStudentSupportResponse(studentRequest, chatLimpo, {
                cpfConfirmado: true,
                assunto: topic,
                opcoesEscola: ['financeiro', 'atendimento', 'coordenacao', 'turmas', 'aulas', 'links', 'material']
            });

            await sendBotReply(chatLimpo, supportResponse);
            return res.status(200).send('Aluno atendido');
        }

        const aiResponse = await getGroqResponse(messageText, chatLimpo);
        await sendBotReply(chatLimpo, aiResponse);

        return res.status(200).send('OK');
    } catch (error) {
        console.error('ERRO FATAL no webhook:', error);
        return res.status(200).send('Erro');
    }
});

app.listen(PORT, () => {
    console.log(`Servidor rodando na porta ${PORT}`);
    console.log('Memoria de conversa ativada.');
});
