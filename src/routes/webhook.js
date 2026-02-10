const express = require('express');
const router = express.Router();

// Rota do Webhook (rota local; a lÃ³gica principal estÃ¡ em src/index.js)
router.post("/webhook", async (req, res) => {
    // Captura os dados da requisição (ajustado conforme sua imagem)
    const mensagemCliente = req.body?.message || req.body?.text || null;
    const numeroCliente = req.body?.phone || req.body?.from || null;

    if (!mensagemCliente || !numeroCliente) {
        return res.sendStatus(200);
    }

    console.log("📩 Webhook recebido");
    console.log("👤 Cliente:", numeroCliente);
    console.log("💬 Mensagem:", mensagemCliente);

    // Sempre responda com 200 para o serviço de Webhook não reenviar a mesma mensagem
    return res.status(200).json({ status: "ok" });
});

// EXPORTAÇÃO OBRIGATÓRIA: Sem isso, o index.js não consegue ler este arquivo
module.exports = router;
