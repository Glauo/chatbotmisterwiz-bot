const { sendMessage } = require('./services/wapi');

async function enviarMensagem(numero, mensagem) {
  return sendMessage(numero, mensagem);
}

module.exports = { enviarMensagem };

