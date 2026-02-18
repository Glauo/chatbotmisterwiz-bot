const axios = require('axios');
require('dotenv').config();

const DEBUG_WEBHOOK = String(process.env.DEBUG_WEBHOOK || '').toLowerCase() === 'true';

// Variáveis da W-API que você vai cadastrar na Railway
const WAPI_URL = process.env.WAPI_URL || '';
const WAPI_TOKEN = process.env.WAPI_TOKEN || '';

function cleanNumber(value) {
    if (!value) return '';
    return String(value).replace(/\D/g, '');
}

async function sendMessage(phone, message) {
    try {
        if (!WAPI_URL || !WAPI_TOKEN) {
            console.error('❌ W-API não configurada. Faltam as variáveis WAPI_URL ou WAPI_TOKEN na Railway.');
            return;
        }

        const destinations = Array.isArray(phone) ? phone : [phone];
        const cleanDestinations = destinations.map(cleanNumber).filter(Boolean);

        if (!cleanDestinations.length) {
            console.error('❌ Número inválido para envio:', phone);
            return;
        }

        // A maioria das W-APIs usa Bearer Token
        const config = {
            headers: {
                'Authorization': `Bearer ${WAPI_TOKEN}`,
                'Content-Type': 'application/json'
            }
        };

        for (const numero of cleanDestinations) {
            try {
                console.log(`🚀 Enviando via W-API para ${numero}...`);
                
                // Formato de disparo padrão da W-API
                const payload = {
                    phone: numero,
                    message: message
                };

                const response = await axios.post(WAPI_URL, payload, config);
                
                if (DEBUG_WEBHOOK) console.log('✅ W-API Respondeu:', JSON.stringify(response.data));
                console.log('✅ Mensagem enviada com sucesso pela W-API.');
                return response.data;
            } catch (error) {
                console.error(`❌ Erro no envio para ${numero} pela W-API:`);
                if (error.response) {
                    console.error(`Status: ${error.response.status}`);
                    console.error('Detalhe:', JSON.stringify(error.response.data, null, 2));
                } else {
                    console.error(error.message);
                }
            }
        }
    } catch (error) {
        console.error('❌ Erro geral no wapi.js:', error.message);
    }
}

module.exports = { sendMessage };