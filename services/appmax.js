let fetch;
if (typeof global.fetch === 'function') {
  fetch = global.fetch;
} else {
  try {
    fetch = require('node-fetch-native' in global ? 'node-fetch-native' : 'node-fetch');
  } catch (e) {
    // Caso de falha silenciosa para evitar erros de inicialização; jogará erro na execução se undefined
  }
}

class AppmaxService {
  constructor() {
    this.token = process.env.APPMAX_API_TOKEN || '';
    this.testMode = String(process.env.APPMAX_TEST_MODE || 'true').toLowerCase() === 'true';
    this.baseUrl = this.testMode
      ? 'https://homolog.sandboxappmax.com.br/api/v3'
      : 'https://admin.appmax.com.br/api/v3';
  }

  async request(endpoint, body = {}) {
    const url = `${this.baseUrl}/${endpoint.replace(/^\//, '')}`;
    
    // Injeta o access-token se não fornecido
    const payload = {
      'access-token': this.token,
      ...body
    };

    console.log(`[AppmaxService] POST Request to: ${url}`, {
      ...payload,
      'access-token': payload['access-token'] ? '***' + payload['access-token'].slice(-5) : 'missing',
      card: payload.card ? { ...payload.card, number: '****', cvv: '***' } : undefined
    });

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    });

    const text = await response.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch (e) {
      console.error(`[AppmaxService] Failed to parse JSON response:`, text);
      throw new Error(`Erro na comunicação com a Appmax (HTTP ${response.status}): ${text.slice(0, 100)}`);
    }

    console.log(`[AppmaxService] Response status ${response.status}:`, data);

    if (data.status === 'fail' || data.success === false || response.status >= 400) {
      const errorMsg = data.message || (data.data && data.data.message) || 'Erro desconhecido na AppMax';
      throw new Error(errorMsg);
    }

    return data;
  }

  /**
   * Cadastra um cliente
   */
  async createCustomer({ name, email, phone, document_number }) {
    // Limpa telefone e CPF para enviar apenas números
    const cleanPhone = phone ? String(phone).replace(/\D/g, '') : '';
    const cleanDocument = document_number ? String(document_number).replace(/\D/g, '') : '';

    // Divide o nome completo em primeiro nome e sobrenome
    const nameParts = String(name || '').trim().split(/\s+/);
    const firstname = nameParts[0] || 'Cliente';
    const lastname = nameParts.slice(1).join(' ') || '.';

    try {
      const resp = await this.request('/customer', {
        firstname,
        lastname,
        email: String(email || '').trim(),
        telephone: cleanPhone,
        document_number: cleanDocument
      });

      // Retorna o ID do cliente criado
      return resp.data?.id || resp.id;
    } catch (err) {
      console.error('[AppmaxService] Erro ao cadastrar cliente:', err.message);
      throw err;
    }
  }

  /**
   * Cria um pedido
   */
  async createOrder({ customer_id, product, amount }) {
    try {
      const resp = await this.request('/order', {
        customer_id,
        products: [
          {
            sku: product.id || 'PROD_DEFAULT',
            name: product.nameSoft || product.name || 'Produto',
            qty: 1,
            price: Number(amount.toFixed(2))
          }
        ]
      });

      return resp.data?.id || resp.id;
    } catch (err) {
      console.error('[AppmaxService] Erro ao criar pedido:', err.message);
      throw err;
    }
  }

  /**
   * Tokeniza o cartão de crédito no backend
   */
  async tokenizeCard({ name, number, cvv, month, year }) {
    try {
      const resp = await this.request('/tokenize/card', {
        card: {
          name: String(name).trim(),
          number: String(number).replace(/\D/g, ''),
          cvv: String(cvv).replace(/\D/g, ''),
          month: parseInt(month, 10),
          year: parseInt(year, 10)
        }
      });

      return resp.data?.token || resp.token;
    } catch (err) {
      console.error('[AppmaxService] Erro ao tokenizar cartão:', err.message);
      throw err;
    }
  }

  /**
   * Processa pagamento via Pix
   */
  async createPixPayment({ order_id, customer_id, document_number }) {
    const cleanDocument = document_number ? String(document_number).replace(/\D/g, '') : '';
    try {
      const resp = await this.request('/payment/pix', {
        cart: {
          order_id
        },
        customer: {
          customer_id
        },
        payment: {
          pix: {
            document_number: cleanDocument
          }
        }
      });

      // Trata possíveis variações nas chaves do QR Code e Pix Copia e Cola
      const paymentData = resp.data || resp;
      const pixCode = paymentData.pix_emv || paymentData.pix_code || paymentData.qr_code || paymentData.copy_paste_code || (paymentData.pix && paymentData.pix.pix_code);
      const pixImage = paymentData.pix_qrcode || paymentData.pix_image || paymentData.pix_qr_code || paymentData.qr_code_base64 || paymentData.pix_qrcode_base64 || (paymentData.pix && paymentData.pix.pix_image);
      const paymentId = paymentData.id || paymentData.payment_id || order_id;

      if (!pixCode) {
        throw new Error('Código Pix não foi retornado pela API da Appmax.');
      }

      return {
        payment_id: paymentId,
        qr_code: pixCode,
        qr_code_base64: pixImage,
        status: paymentData.status || 'pending'
      };
    } catch (err) {
      console.error('[AppmaxService] Erro ao criar pagamento Pix:', err.message);
      throw err;
    }
  }

  /**
   * Processa pagamento via Cartão de Crédito
   */
  async createCardPayment({ order_id, customer_id, token, cvv, installments, document_number }) {
    const cleanDocument = document_number ? String(document_number).replace(/\D/g, '') : '';
    try {
      const resp = await this.request('/payment/credit-card', {
        cart: {
          order_id
        },
        customer: {
          customer_id
        },
        payment: {
          CreditCard: {
            token: token,
            cvv: String(cvv).replace(/\D/g, ''),
            document_number: cleanDocument,
            installments: parseInt(installments || 1, 10),
            soft_descriptor: 'COMPRASLIVRE'
          }
        }
      });

      const paymentData = resp.data || resp;
      return {
        payment_id: paymentData.id || paymentData.payment_id || order_id,
        status: paymentData.status || 'approved'
      };
    } catch (err) {
      console.error('[AppmaxService] Erro ao processar pagamento de Cartão:', err.message);
      throw err;
    }
  }
}

module.exports = new AppmaxService();
