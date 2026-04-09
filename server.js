// backend/server.js
const express = require('express');
const { MercadoPagoConfig, Payment, Preference } = require('mercadopago');
const dotenv = require('dotenv');

// ========== FIREBASE ADMIN ==========
const admin = require('firebase-admin');

// Função para carregar a chave do Firebase (funciona localmente e no Render)
function getFirebaseServiceAccount() {
  // Tenta carregar da variável de ambiente (Render)
  if (process.env.FIREBASE_SERVICE_ACCOUNT) {
    try {
      return JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    } catch (error) {
      console.error('Erro ao parsear FIREBASE_SERVICE_ACCOUNT:', error);
    }
  }
  
  // Fallback: carrega do arquivo local (desenvolvimento)
  try {
    return require('./serviceAccountKey.json');
  } catch (error) {
    console.error('Erro ao carregar serviceAccountKey.json:', error);
    throw new Error('Não foi possível carregar as credenciais do Firebase');
  }
}

// Inicializa o Firebase com a chave obtida
const serviceAccount = getFirebaseServiceAccount();
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

const db = admin.firestore();
// ====================================

dotenv.config();

const app = express();
app.use(express.json());

// Configuração do Mercado Pago
const client = new MercadoPagoConfig({
  accessToken: process.env.MERCADO_PAGO_ACCESS_TOKEN,
});

// Endpoint de criação de pagamento
app.post('/criar-pagamento', async (req, res) => {
  const { valor, metodo, userId } = req.body;
  const paymentApi = new Payment(client);

  try {
    if (metodo === 'checkout') {
      const preferenceApi = new Preference(client);
      const preference = await preferenceApi.create({
        body: {
          items: [{ title: 'Doação para o App', quantity: 1, unit_price: Number(valor) }],
          back_urls: {
            success: 'https://www.mercadopago.com.br',
            failure: 'https://www.mercadopago.com.br',
          },
          auto_return: 'approved',
          external_reference: String(userId),
        },
      });
      console.log('Preference criada:', preference.id);
      res.json({ init_point: preference.init_point });
    } else {
      const payment = await paymentApi.create({
        body: {
          transaction_amount: Number(valor),
          description: 'Doação para o app',
          payment_method_id: 'pix',
          payer: { email: `doador_${Date.now()}@gmail.com` },
          external_reference: String(userId),
        },
      });
      console.log('Payment Pix criado:', payment.id);
      const { qr_code, qr_code_base64 } = payment.point_of_interaction.transaction_data;
      res.json({ qr_code, qr_code_base64, copy_paste: qr_code });
    }
  } catch (error) {
    console.error('Erro no Mercado Pago:', error);
    res.status(500).json({ error: 'Erro ao processar pagamento' });
  }
});

// Endpoint de webhook para notificações de pagamento
app.post('/webhook/mercadopago', async (req, res) => {
  const { type, data } = req.body;
  console.log('🔔 Webhook recebido:', { type, data });

  if (type === 'payment') {
    const paymentId = data.id;
    try {
      const paymentApi = new Payment(client);
      const payment = await paymentApi.get({ id: paymentId });
      console.log(`💳 Pagamento ${paymentId} - Status: ${payment.status}`);

      if (payment.status === 'approved') {
        const userId = payment.external_reference;
        console.log(`✅ Pagamento aprovado! Usuário: ${userId}`);

        try {
          // Data de expiração do selo: 30 dias a partir de agora
          const supporterUntil = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

          // Atualiza o documento do usuário no Firestore
          await db.collection('users').doc(userId).update({
            supporterUntil: admin.firestore.Timestamp.fromDate(supporterUntil),
          });

          console.log(`🎉 Selo concedido ao usuário ${userId} até ${supporterUntil.toLocaleDateString()}`);
        } catch (dbError) {
          console.error('❌ Erro ao atualizar Firestore:', dbError);
        }
      }
    } catch (error) {
      console.error('❌ Erro ao processar webhook:', error);
    }
  }

  // Sempre retornar 200 OK para o Mercado Pago
  res.sendStatus(200);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});