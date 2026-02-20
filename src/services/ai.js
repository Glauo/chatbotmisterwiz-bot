const Groq = require('groq-sdk');
const { getActiveKnowledgeSnippet } = require('./knowledge');

// --- SUA CHAVE (use .env) ---
const MINHA_CHAVE_GROQ = (process.env.GROQ_API_KEY || '').trim();
if (!MINHA_CHAVE_GROQ) {
    console.warn("GROQ_API_KEY não encontrada. Verifique o .env carregado.");
}

const groq = new Groq({ apiKey: MINHA_CHAVE_GROQ });

// Memória da conversa
const history = {};
const studentHistory = {};

function buildActiveKnowledgeInstruction({ audience, maxChars }) {
    const snippet = getActiveKnowledgeSnippet(maxChars);
    if (!snippet) return '';

    return [
        `Base de conhecimento Active para ${audience}:`,
        snippet,
        'Use esta base como referencia prioritaria quando a solicitacao estiver relacionada ao sistema Active.'
    ].join('\n');
}

// ============================================================================
// 🧠 CÉREBRO MISTER WIZ (Versão Alinhada: Valor, Retenção e Argumentos)
// ============================================================================
const SYSTEM_PROMPT = `
VOCÊ É: "Wiz", consultor oficial da escola MISTER WIZ (Ribeirão Preto).
FUNDADOR: Carlos Wizard.
OBJETIVO: Atendimento consultivo. Gerar desejo antes de falar de preço.

---

👋 PASSO 1: A SAUDAÇÃO PERFEITA (Mantenha este padrão)
Se for a primeira mensagem ou você não souber o nome:
"Olá! Seja muito bem-vindo à Mister Wiz! 🦁✨
Eu sou o Wiz, consultor aqui da escola. Para que eu possa te atender com excelência hoje, com quem eu tenho o prazer de falar? 📝"
(Espere o cliente responder o nome).

---

💎 POR QUE A MISTER WIZ É A MELHOR OPÇÃO? (Use esses argumentos durante a conversa)
Se o cliente quer aprender de verdade, mostre nossos pilares:
1. VELOCIDADE REAL: "Enquanto escolas tradicionais levam 5 anos, nós garantimos sua fluência em APENAS 2 ANOS."
2. MÉTODO CARLOS WIZARD: "Utilizamos a metodologia do maior especialista do Brasil. Foco 100% em conversação, sem tradução mental."
3. ALÉM DO INGLÊS: "Somos a única que trabalha Inteligência Emocional e Liderança junto com o idioma. Preparamos você para a vida real."

---

🛑 REGRA DE OURO SOBRE PREÇOS:
- NÃO INFORME VALORES SE O CLIENTE NÃO PERGUNTAR.
- Foque primeiro em entender o nível e apresentar o método.
- Se ele perguntar "quanto custa?", apresente as modalidades primeiro e pergunte qual ele prefere. SÓ DEPOIS passe o valor.

---

📋 AS MODALIDADES (O Funil)
1. Presencial em Turma 🏫
2. Online em Turma 💻
3. VIP (Particular - Presencial/Online) 💎
4. Intensivo VIP Online (Ouro - Matrícula Grátis) 🏆

---

💰 TABELA DE PREÇOS (Use somente se perguntado):
- VIP (Particular): Aula avulsa R$ 150 ou Pacote 10 aulas (R$ 130 cada).
- Intensivo VIP: R$ 299 mensal + MATRÍCULA ISENTA! 🎉
- Turmas (Presencial/Online): R$ 312 mensal + Matrícula R$ 299.
- Kids: R$ 329 mensal + Matrícula R$ 299.
(Material R$ 550 para todos).

---

📉 GATILHO DE DESCONTO (15% OFF) - REGRAS RÍGIDAS:
SÓ OFEREÇA O DESCONTO DE 15% SE O CLIENTE DISSER UMA DESSAS FRASES:
1. "Vou pensar"
2. "Vou pesquisar"
3. "Está caro"
4. "Depois eu retorno"

RESPOSTA PARA ESSES CASOS:
"Entendo, [Nome]. Mas não quero que o valor seja uma barreira para o seu futuro. Se fecharmos a matrícula agora, consigo autorizar 15% DE DESCONTO nas mensalidades. Fica bem mais acessível! Vamos aproveitar?"

(NÃO dê desconto em nenhuma outra situação).

---

🏁 FECHAMENTO:
- Se o cliente topar: "Perfeito, [Nome]! 👏 Vou passar seu cadastro para o nosso Setor de Matrículas. Aguarde um instante que entraremos em contato para finalizar! 🦁"

`;

async function getGroqResponse(userMessage, userId) {
    try {
        if (!history[userId]) history[userId] = [];
        
        history[userId].push({ role: "user", content: userMessage });
        
        if (history[userId].length > 15) history[userId] = history[userId].slice(-15);

        const messagesToSend = [
            { role: "system", content: SYSTEM_PROMPT },
            ...history[userId]
        ];

        const chatCompletion = await groq.chat.completions.create({
            messages: messagesToSend,
            model: "llama-3.1-8b-instant",
            temperature: 0.3, 
            max_tokens: 450,
        });

        const aiResponse = chatCompletion.choices[0]?.message?.content || "Olá! Seja bem-vindo à Mister Wiz! 🦁 Com quem falo?";
        
        history[userId].push({ role: "assistant", content: aiResponse });

        return aiResponse;

    } catch (error) {
        console.error("Erro Groq:", error);
        history[userId] = []; 
        return "Minha conexão oscilou. Pode repetir, por favor? 🦁";
    }
}

function clearHistory(userId) {
    if (history[userId]) {
        history[userId] = [];
    }
}

async function getStudentSupportResponse(userMessage, userId, context = {}) {
    const text = String(userMessage || '').trim();
    if (!text) {
        return 'Me diga qual demanda voce precisa resolver agora na Active.';
    }

    if (!MINHA_CHAVE_GROQ) {
        return [
            'CPF confirmado.',
            'Posso ajudar com financeiro, turmas, aulas, links, material ou outra solicitacao da Active.'
        ].join(' ');
    }

    try {
        const activeKnowledgeInstruction = buildActiveKnowledgeInstruction({
            audience: 'atendimento de aluno',
            maxChars: Number(process.env.ACTIVE_KNOWLEDGE_PROMPT_MAX_CHARS) || 2200
        });

        if (!studentHistory[userId]) studentHistory[userId] = [];
        studentHistory[userId].push({ role: 'user', content: text });

        if (studentHistory[userId].length > 15) {
            studentHistory[userId] = studentHistory[userId].slice(-15);
        }

        const completion = await groq.chat.completions.create({
            model: 'llama-3.1-8b-instant',
            temperature: 0.2,
            max_tokens: 380,
            messages: [
                {
                    role: 'system',
                    content: [
                        'Voce e Wiz IA no atendimento de alunos da Active.',
                        'Sempre considere que o CPF ja foi confirmado.',
                        'Atenda pedidos sobre financeiro, turmas, aulas, links, material e suporte escolar.',
                        'Se faltar dado para executar, peca de forma objetiva.',
                        'Seja curto e direto, sem discurso comercial.',
                        activeKnowledgeInstruction
                    ].join(' ')
                },
                {
                    role: 'user',
                    content: JSON.stringify({
                        message: text,
                        context
                    })
                },
                ...studentHistory[userId]
            ]
        });

        const response =
            completion.choices[0]?.message?.content?.trim() ||
            'Entendi. Vou te ajudar com isso agora. Pode me passar os dados que faltam?';

        studentHistory[userId].push({ role: 'assistant', content: response });
        return response;
    } catch (error) {
        console.error('Erro no suporte de aluno IA:', error.message || error);
        studentHistory[userId] = [];
        return 'Nao consegui concluir agora. Pode repetir sua solicitacao?';
    }
}

function clearStudentHistory(userId) {
    if (studentHistory[userId]) {
        studentHistory[userId] = [];
    }
}

module.exports = {
    getGroqResponse,
    clearHistory,
    getStudentSupportResponse,
    clearStudentHistory
};
