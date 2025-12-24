require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const crypto = require('crypto');
const { Pool } = require('pg');
const { MercadoPagoConfig, Payment } = require('mercadopago');

const app = express();
app.use(bodyParser.json({ type: ['application/json', 'text/plain', 'application/*+json'] }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));
app.set('view engine', 'ejs');
app.set('views', 'views');


// DB Postgres
const pool = new Pool(process.env.DATABASE_URL ? {
	connectionString: process.env.DATABASE_URL,
	ssl: process.env.PGSSLMODE === 'require' ? { rejectUnauthorized: false } : undefined
} : {
	host: process.env.PGHOST,
	port: Number(process.env.PGPORT),
	user: process.env.PGUSER,
	password: process.env.PGPASSWORD,
	database: process.env.PGDATABASE
});

async function initSchema() {
	await pool.query(`
		CREATE TABLE IF NOT EXISTS payments (
			id SERIAL PRIMARY KEY,
			payment_id TEXT UNIQUE,
			amount INTEGER NOT NULL,
			description TEXT,
			status TEXT NOT NULL DEFAULT 'pending',
			target_url TEXT NOT NULL,
			access_token TEXT UNIQUE NOT NULL,
			email TEXT,
			access_password TEXT,
			product_url TEXT,
			created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
			paid_at TIMESTAMP
		);
	`);
	await pool.query(`ALTER TABLE payments ADD COLUMN IF NOT EXISTS email TEXT;`);
	await pool.query(`ALTER TABLE payments ADD COLUMN IF NOT EXISTS access_password TEXT;`);
	await pool.query(`ALTER TABLE payments ADD COLUMN IF NOT EXISTS product_url TEXT;`);
	// Índices úteis
	await pool.query(`CREATE INDEX IF NOT EXISTS idx_payments_status_created ON payments (status, created_at DESC);`);
}
initSchema().catch(err => {
	console.error('Erro ao inicializar schema Postgres:', err);
	process.exit(1);
});

// Poller de pagamentos pendentes (reduz latência se webhook atrasar)
function startPendingPoller() {
	const enabled = String(process.env.POLLER_ENABLED || 'true').toLowerCase() === 'true';
	if (!enabled) {
		console.log('Pending poller desativado (POLLER_ENABLED=false)');
		return;
	}
	const intervalMs = Number(process.env.POLLER_INTERVAL_MS || 15000);
	const lookbackMin = Number(process.env.POLLER_LOOKBACK_MIN || 60);
	const batchSize = Number(process.env.POLLER_BATCH || 25);

	async function tick() {
		try {
			// Busca pendentes recentes
			const { rows } = await pool.query(
				`SELECT payment_id FROM payments
				  WHERE status='pending' AND created_at >= NOW() - INTERVAL '${lookbackMin} minutes'
				  ORDER BY created_at DESC
				  LIMIT $1`,
				[batchSize]
			);
			if (!rows || rows.length === 0) return;

			for (const r of rows) {
				const pid = String(r.payment_id);
				try {
					const details = await withTimeout(
						payment.get({ id: pid }),
						Number(process.env.MP_GET_TIMEOUT_MS || 10000),
						'payment.get'
					);
					const status = (details && details.status) || (details.body && details.body.status);
					if (status === 'approved') {
						await pool.query(
							`UPDATE payments
							   SET status='paid',
							       paid_at = COALESCE(paid_at, CURRENT_TIMESTAMP),
							       access_password = COALESCE(access_password, $2)
							 WHERE payment_id=$1`,
							[pid, generatePassword()]
						);
						console.log('Poller: pagamento aprovado', { payment_id: pid });
					}
				} catch (e) {
					// Silencia erros pontuais para não interromper o loop
				}
			}
		} catch (err) {
			console.error('Erro no poller de pendentes:', err.message || err);
		}
	}

	setInterval(tick, intervalMs);
	console.log(`Pending poller iniciado (intervalo ${intervalMs}ms, lookback ${lookbackMin}min, batch ${batchSize})`);
}
startPendingPoller();
// Mercado Pago SDK
const mpClient = new MercadoPagoConfig({ accessToken: process.env.MP_ACCESS_TOKEN });
const payment = new Payment(mpClient);

// Util: gera token curto para acesso
function generateAccessToken() {
	return crypto.randomBytes(12).toString('hex');
}

function generatePassword() {
	return crypto.randomBytes(6).toString('base64').replace(/[^a-zA-Z0-9]/g, '').slice(0, 10);
}

async function withTimeout(promise, ms, contextLabel) {
	let timer;
	try {
		return await Promise.race([
			promise,
			new Promise((_, reject) => {
				timer = setTimeout(() => {
					const err = new Error(`Timeout após ${ms}ms`);
					err.code = 'ETIMEDOUT';
					err.context = contextLabel;
					reject(err);
				}, ms);
			})
		]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}
// Checagem básica de configuração
if (!process.env.MP_ACCESS_TOKEN) {
	console.error('MP_ACCESS_TOKEN ausente. Defina no arquivo .env');
} else {
	const token = process.env.MP_ACCESS_TOKEN;
	const tokenType = token.startsWith('TEST-') ? 'TEST' : (token.startsWith('APP_USR-') ? 'LIVE' : 'DESCONHECIDO');
	console.log(`Mercado Pago token detectado: ${tokenType}`);
}

// Config pública para o frontend (defaults controlados pelo backend)
app.get('/config', (req, res) => {
	return res.json({
		defaultAmount: process.env.DEFAULT_AMOUNT ? Number(process.env.DEFAULT_AMOUNT) : 10.0,
		defaultDescription: process.env.DEFAULT_DESCRIPTION || 'Acesso PIX',
		baseUrlPublica: process.env.BASE_URL_PUBLICA || '',
		version: 'mvp-frontend-1'
	});
});

// Produto único no back-end
const products = [
	{ id: 'cap1ano', name: 'CapCut Pro 2026 - 1 Ano - Compartilhado + Brinde Canva', description: 'CapCut PRO 2026 ⭐⭐⭐⭐⭐ (4.9) 1 Ano Compartilhado - app de edição de vídeos com transições, filtros, textos e trilhas sonoras. Corte e ajuste de áudio para clipes criativos, sem marca d’água. Uso imediato, envio imediato e licença oficial garantida.', price: 57, urlProduto: 'https://docs.google.com/document/d/1y25e0Ge2UqeAGy_MZxL_6Z4YpXQqV5U1C_3dVBKyNrU/edit?usp=sharing', image: "pro2026.jpg"},
	{ id: 'cap1mescomp', name: 'CapCut Pro 2026 - Licença de 30 dias Compartilhado', description: 'CapCut PRO 2026 ⭐⭐⭐⭐⭐ (4.9) 1 Mês Compartilhado - app de edição de vídeos com transições, filtros, textos e trilhas sonoras. Corte e ajuste de áudio para clipes criativos, sem marca d’água. Uso imediato, envio imediato e licença oficial garantida.', price: 17, urlProduto: 'https://docs.google.com/document/d/1ImV1GkzXYtK_IloqBW6eNF6Rr2UUd0BdWdKza_S4DGA/edit?usp=sharing', image: "pro2026.jpg"},
	{ id: 'cap1mespriv', name: 'CapCut Pro 2026 - Licença Privada 30 Dias No Seu E-mail', description: 'CapCut PRO 2026 ⭐⭐⭐⭐⭐ (4.9) 1 Mês Privado - app de edição de vídeos com transições, filtros, textos e trilhas sonoras. Corte e ajuste de áudio para clipes criativos, sem marca d’água. Uso imediato, envio imediato e licença oficial garantida.', price: 27, urlProduto: 'https://docs.google.com/document/d/13cQrofUV16I6OTMwokkpxFwk84AgHXmFZovjUpOu8K4/edit?usp=sharing', image: "pro2026.jpg"},
	{ id: 'teste', name: 'PROD Teste', description: 'CapCut PRO 2026 ⭐⭐⭐⭐⭐ (4.9) 1 Mês Privado - app de edição de vídeos com transições, filtros, textos e trilhas sonoras. Corte e ajuste de áudio para clipes criativos, sem marca d’água. Uso imediato, envio imediato e licença oficial garantida.', price: 2, urlProduto: 'https://docs.google.com/document/d/13cQrofUV16I6OTMwokkpxFwk84AgHXmFZovjUpOu8K4/edit?usp=sharing', image: "pro2026.jpg"}
];

// Home - lista de produtos
app.get('/', (req, res) => {
	res.render('capcut', { products });
});

// Landing CapCut
app.get('/capcut', (req, res) => {
	res.render('capcut', {products});
});

// Página de detalhe do produto com formulário de e-mail
app.get('/produto/:id', (req, res) => {
	const { id } = req.params;
	const product = products.find(p => p.id === id);
	if (!product) return res.status(404).send('Produto não encontrado');
	const requireCpf = String(process.env.MP_REQUIRE_CPF || '').toLowerCase() === 'true';
	res.render('product_detail', { product, requireCpf });
});

// Helper para criar PIX e persistir
async function createPixAndPersist({ amount, description, targetUrl, payer, email, productUrl }) {
	const transactionAmount = Number((amount).toFixed(2));
	const idempotency = crypto.randomUUID();

	const payerPayload =
		(payer && typeof payer === 'object')
			? payer
			: {
				email: process.env.MP_PAYER_EMAIL || 'test_user_123456@testuser.com',
				first_name: 'Test',
				last_name: 'User',
				identification: { type: 'CPF', number: '19119119100' }
			};

	const requestBody = {
		transaction_amount: transactionAmount,
		payment_method_id: 'pix',
		description,
		payer: payerPayload
	};
	if (process.env.BASE_URL_PUBLICA) {
		requestBody.notification_url = `${process.env.BASE_URL_PUBLICA.replace(/\/$/, '')}/webhook/mercadopago`;
	}

	console.log('Criando pagamento PIX...', { description, amount: transactionAmount, email, idempotency });
	const startedAt = Date.now();
	const createResp = await withTimeout(
		payment.create({ body: requestBody }, { idempotencyKey: idempotency }),
		Number(process.env.MP_CREATE_TIMEOUT_MS || 15000),
		'payment.create'
	);
	console.log('Pagamento criado', { ms: Date.now() - startedAt });
	const mp = createResp || {};
	const paymentId = mp.id || (mp.body && mp.body.id);
	const pix = (mp.point_of_interaction && mp.point_of_interaction.transaction_data) ||
		(mp.body && mp.body.point_of_interaction && mp.body.point_of_interaction.transaction_data) || {};
	const qrCode = pix.qr_code;
	const qrCodeBase64 = pix.qr_code_base64;

	if (!paymentId || !qrCode) throw new Error('Falha ao gerar PIX');

	const accessToken = generateAccessToken();
	const finalTarget = targetUrl || `/obrigado/${accessToken}`;
	await pool.query(
		`INSERT INTO payments (payment_id, amount, description, target_url, access_token, status, email, product_url)
		 VALUES ($1, $2, $3, $4, $5, 'pending', $6, $7)`,
		[paymentId.toString(), Math.round(transactionAmount * 100), description, finalTarget, accessToken, email || null, productUrl || null]
	);

	return {
		payment_id: paymentId,
		qr_code: qrCode,
		qr_code_base64: qrCodeBase64,
		token_de_acesso: accessToken,
		status_url: `/status/${paymentId}`,
		acesso_url: `/acesso/${accessToken}`,
		amount: transactionAmount,
		description
	};
}

// Comprar produto e renderizar checkout
app.post('/buy/:id', async (req, res) => {
	try {
		const { id } = req.params;
		const email = (req.body && req.body.email) ? String(req.body.email).trim() : '';
		const cpf = (req.body && req.body.cpf) ? String(req.body.cpf).replace(/\D/g, '') : '';
		const product = products.find(p => p.id === id);
		if (!product) return res.status(404).send('Produto não encontrado');
		if (!email) return res.status(400).send('E-mail é obrigatório');
		const requireCpf = String(process.env.MP_REQUIRE_CPF || '').toLowerCase() === 'true';
		if (requireCpf && (!cpf || cpf.length < 11)) {
			return res.status(400).send('CPF é obrigatório para este produto.');
		}
		if (!process.env.MP_ACCESS_TOKEN) {
			return res.status(500).send('Configuração inválida: MP_ACCESS_TOKEN não definido.');
		}
		const payer =
			requireCpf && cpf
				? { email, identification: { type: 'CPF', number: cpf } }
				: { email };
		const data = await createPixAndPersist({
			amount: product.price,
			description: product.name,
			targetUrl: null,
			payer,
			email,
			productUrl: product.urlProduto
		});
		return res.render('checkout', { data, product });
	} catch (err) {
		const status = err && (err.status || err.statusCode);
		const message = (err && (err.message || err.code)) ||
			(err && err.cause && err.cause[0] && (err.cause[0].description || err.cause[0].message)) ||
			'Erro desconhecido';
		console.error('Erro /buy:', { status, message });
		if (message && String(message).includes('Timeout')) {
			return res.status(504).send('Timeout ao criar pagamento PIX. Tente novamente.');
		}
		return res.status(500).send(`Erro ao criar pagamento PIX: ${message}`);
	}
});

// Membros - login (GET) e submissão (POST)
app.get('/membros', (req, res) => {
	res.render('membros_login', { error: '', email: '' });
});

app.post('/membros', async (req, res) => {
	try {
		const email = (req.body && req.body.email) ? String(req.body.email).trim() : '';
		const password = (req.body && req.body.password) ? String(req.body.password).trim() : '';
		if (!email || !password) {
			return res.render('membros_login', { error: 'Informe e-mail e senha.', email });
		}
		const { rows } = await pool.query(
			`SELECT id, description, product_url, created_at
			   FROM payments
			  WHERE email=$1 AND access_password=$2 AND status='paid'
			  ORDER BY created_at DESC
			  LIMIT 50`,
			[email, password]
		);
		if (!rows || rows.length === 0) {
			return res.render('membros_login', { error: 'Credenciais inválidas ou pagamento não confirmado.', email });
		}
		// Filtra somente registros com product_url definido
		const items = rows.filter(r => !!r.product_url);
		return res.render('membros_area', { email, items });
	} catch (err) {
		console.error('Erro /membros:', err);
		return res.render('membros_login', { error: 'Erro no servidor. Tente novamente.', email: '' });
	}
});

// Obrigado - mostra credenciais e coleta e-mail
app.get('/obrigado/:token', async (req, res) => {
	try {
		const { token } = req.params;
		const { rows } = await pool.query(
			`SELECT payment_id, status, access_password, email FROM payments WHERE access_token=$1`,
			[token]
		);
		const row = rows[0];
		if (!row) return res.status(404).send('Token inválido');
		if (row.status !== 'paid') return res.status(402).send('Pagamento ainda não confirmado');
		// Garante senha
		let pass = row.access_password;
		if (!pass) {
			pass = generatePassword();
			await pool.query(
				`UPDATE payments SET access_password=$1 WHERE access_token=$2`,
				[pass, token]
			);
		}
		return res.render('obrigado', { email: row.email || '', password: pass });
	} catch (err) {
		return res.status(500).send('Erro ao carregar página de obrigado.');
	}
});

app.post('/obrigado/:token/email', async (req, res) => {
	try {
		const { token } = req.params;
		const { email } = req.body || {};
		if (!email) return res.status(400).send('E-mail é obrigatório');
		await pool.query(
			`UPDATE payments SET email=$1 WHERE access_token=$2`,
			[email, token]
		);
		return res.redirect(`/obrigado/${token}`);
	} catch (err) {
		return res.status(500).send('Erro ao salvar e-mail.');
	}
});

// POST /checkout - cria pagamento PIX
app.post('/checkout', async (req, res) => {
	try {
		const { amount, description = 'PIX', targetUrl, payer } = req.body || {};
		if (!amount || !targetUrl) {
			return res.status(400).json({ error: 'amount e targetUrl são obrigatórios.' });
		}
		if (!process.env.MP_ACCESS_TOKEN) {
			return res.status(500).json({ error: 'Configuração inválida: MP_ACCESS_TOKEN não definido.' });
		}
		// Evita confusão: credencial LIVE com payer de teste
		if (process.env.MP_ACCESS_TOKEN.startsWith('APP_USR-')) {
			const cpfBody = payer && payer.identification && payer.identification.number;
			const isTestCpf = cpfBody === '19119119100';
			if (!payer || isTestCpf) {
				return res.status(400).json({
					error: 'Credencial de PRODUÇÃO detectada. Envie payer real (CPF/E-mail reais) ou use MP_ACCESS_TOKEN de TESTE (TEST-...).'
				});
			}
		}
		// amount em centavos (BRL) → Mercado Pago espera número decimal
		const transactionAmount = Number((amount).toFixed(2));

		const idempotency = crypto.randomUUID();
		// Monta payer: usa fornecido no body ou fallback de sandbox
		const payerPayload =
			(payer && typeof payer === 'object')
				? payer
				: {
					email: process.env.MP_PAYER_EMAIL || 'test_user_123456@testuser.com',
					first_name: 'Test',
					last_name: 'User',
					identification: {
						type: 'CPF',
						number: '19119119100' // CPF de teste do MP
					}
				};

		const requestBody = {
			transaction_amount: transactionAmount,
			payment_method_id: 'pix',
			description,
			payer: payerPayload
		};

		// Se tiver BASE_URL_PUBLICA, define notification_url
		if (process.env.BASE_URL_PUBLICA) {
			requestBody.notification_url = `${process.env.BASE_URL_PUBLICA.replace(/\/$/, '')}/webhook/mercadopago`;
		}

		const createResp = await payment.create({ body: requestBody }, { idempotencyKey: idempotency });

		const mp = createResp || {};
		const paymentId = mp.id || (mp.body && mp.body.id);
		const pix = (mp.point_of_interaction && mp.point_of_interaction.transaction_data) ||
					(mp.body && mp.body.point_of_interaction && mp.body.point_of_interaction.transaction_data) ||
					{};

		const qrCode = pix.qr_code;
		const qrCodeBase64 = pix.qr_code_base64;

		if (!paymentId || !qrCode) {
			return res.status(500).json({ error: 'Falha ao gerar PIX.' });
		}

		const accessToken = generateAccessToken();
		await pool.query(
			`INSERT INTO payments (payment_id, amount, description, target_url, access_token, status)
			 VALUES ($1, $2, $3, $4, $5, 'pending')`,
			[paymentId.toString(), Math.round(transactionAmount * 100), description, targetUrl, accessToken]
		);

		return res.json({
			payment_id: paymentId,
			qr_code: qrCode,
			qr_code_base64: qrCodeBase64, // pode exibir diretamente em <img src="data:image/png;base64,..." />
			token_de_acesso: accessToken,
			status_url: `/status/${paymentId}`,
			acesso_url: `/acesso/${accessToken}`
		});
	} catch (err) {
		// Extrai detalhes úteis do erro do SDK do Mercado Pago
		const status = err && (err.status || err.statusCode);
		const message =
			(err && err.message) ||
			(err && err.cause && err.cause[0] && (err.cause[0].description || err.cause[0].message)) ||
			'Erro desconhecido';
		const cause = err && err.cause ? err.cause : undefined;
		console.error('Erro /checkout:', { status, message, cause });
		return res.status(500).json({
			error: 'Erro ao criar pagamento.',
			details: { status, message }
		});
	}
});

// POST /webhook/mercadopago - recebe eventos e confirma status
app.post('/webhook/mercadopago', async (req, res) => {
	try {
        console.log('Recebendo webhook do Mercado Pago...', req.body);
		// Mercado Pago envia diferentes formatos. Normalmente vem { type, action, data: { id } } ou { id, topic }
		const body = req.body || {};
		const topic = body.topic || body.type;
		let id = body.data && body.data.id ? body.data.id : body.id;

		// Caso venha via querystring (?type=payment&id=123)
		if (!id && req.query && (req.query.id || req.query['data.id'])) {
			id = req.query.id || req.query['data.id'];
		}

		if ((topic === 'payment' || topic === 'payments') && id) {
			// Obtém detalhes do pagamento para confirmar
			const details = await payment.get({ id: id.toString() });
			const status = (details && details.status) || (details.body && details.body.status);

			if (status === 'approved') {
				await pool.query(
					`UPDATE payments SET status='paid', paid_at=CURRENT_TIMESTAMP WHERE payment_id=$1`,
					[id.toString()]
				);
				// Gera senha se ainda não existir
				await pool.query(
					`UPDATE payments SET access_password = COALESCE(access_password, $1) WHERE payment_id=$2`,
					[generatePassword(), id.toString()]
				);
			}
		}

		// Responder 200 rapidamente evita reentregas excessivas
		return res.status(200).json({ received: true });
	} catch (err) {
		console.error('Erro webhook:', err);
		// Mesmo em erro, responda 200 para evitar loop; registre para reprocessar se necessário
		return res.status(200).json({ received: true });
	}
});

// GET /status/:payment_id - consulta status salvo
app.get('/status/:payment_id', async (req, res) => {
	try {
		const { payment_id } = req.params;
		const { rows } = await pool.query(
			`SELECT payment_id, status, created_at, paid_at FROM payments WHERE payment_id=$1`,
			[payment_id]
		);
		const row = rows[0];
		if (!row) return res.status(404).json({ error: 'Pagamento não encontrado' });
		return res.json(row);
	} catch (err) {
		return res.status(500).json({ error: 'Erro ao consultar status.' });
	}
});

app.get('/acesso/:token', async (req, res) => {
	try {
		const { token } = req.params;
		const { rows } = await pool.query(
			`SELECT target_url, status FROM payments WHERE access_token=$1`,
			[token]
		);
		const row = rows[0];
		if (!row) return res.status(404).send('Token inválido');
		if (row.status !== 'paid') return res.status(402).send('Pagamento ainda não confirmado');
		// Redireciona para o link específico
		return res.redirect(row.target_url);
	} catch (err) {
		return res.status(500).send('Erro ao processar acesso.');
	}
});

const PORT = process.env.PORT || 3002;
app.listen(PORT, () => {
	console.log(`Servidor rodando na porta ${PORT}`);
});