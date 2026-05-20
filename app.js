require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const crypto = require('crypto');
const { Pool } = require('pg');
const { MercadoPagoConfig, Payment } = require('mercadopago');
const session = require('express-session');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const appmaxService = require('./services/appmax');

// Configuração do Multer para upload de imagens
const storage = multer.diskStorage({
	destination: function (req, file, cb) {
		const dir = './public/images/produtos';
		if (!fs.existsSync(dir)) {
			fs.mkdirSync(dir, { recursive: true });
		}
		cb(null, dir);
	},
	filename: function (req, file, cb) {
		const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
		cb(null, uniqueSuffix + path.extname(file.originalname));
	}
});
const upload = multer({ storage: storage });

function getNextProductId() {
	if (products.length === 0) return 'MLB2026030301';
	const lastProduct = products[products.length - 1];
	const lastId = lastProduct.id;

	// Extrai a parte numérica do final do ID
	const match = lastId.match(/^(.*?)(\d+)$/);
	if (!match) return 'MLB2026030301';

	const prefix = match[1];
	const numberStr = match[2];
	const nextNumber = parseInt(numberStr) + 1;

	// Mantém o preenchimento de zeros à esquerda
	return prefix + nextNumber.toString().padStart(numberStr.length, '0');
}

let products = [];
try {
	products = JSON.parse(fs.readFileSync('./products.json', 'utf8'));
} catch (e) {
	console.error('Erro ao carregar products.json:', e);
}

const app = express();
app.use(bodyParser.json({ type: ['application/json', 'text/plain', 'application/*+json'] }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));
app.set('view engine', 'ejs');
app.set('views', 'views');

// Configuração de Sessão para o Admin
app.use(session({
	secret: process.env.SESSION_SECRET || 'compraslivre-segredo-super-forte-2026',
	resave: false,
	saveUninitialized: false,
	cookie: { maxAge: 24 * 60 * 60 * 1000 } // 24 horas
}));

// Middleware de helper global para imagens
app.use((req, res, next) => {
	res.locals.getImageUrl = function(imagePath) {
		if (!imagePath) return '/images/default.jpg';
		imagePath = imagePath.trim();
		if (imagePath.startsWith('http://') || imagePath.startsWith('https://') || imagePath.startsWith('data:')) {
			return imagePath;
		}
		if (imagePath.startsWith('/images/')) return imagePath;
		if (imagePath.startsWith('images/')) return '/' + imagePath;
		return '/images/' + imagePath;
	};
	next();
});

// Middleware de autenticação
function requireAuth(req, res, next) {
	if (req.session && req.session.admin) {
		return next();
	}
	return res.redirect('/admin/login');
}

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
	await pool.query(`ALTER TABLE payments ADD COLUMN IF NOT EXISTS whatsapp TEXT;`);
	await pool.query(`ALTER TABLE payments ADD COLUMN IF NOT EXISTS product_name TEXT;`);
	await pool.query(`ALTER TABLE payments ADD COLUMN IF NOT EXISTS payment_method TEXT;`);
	// Índices úteis
	await pool.query(`CREATE INDEX IF NOT EXISTS idx_payments_status_created ON payments (status, created_at DESC);`);
}
initSchema().catch(err => {
	console.error('Erro ao inicializar schema Postgres:', err);
	process.exit(1);
});

// Helper para processar aprovação de pagamento e enviar para Google Forms
async function handlePaymentApproved(paymentId) {
	try {
		const { rows: checkRows } = await pool.query(`SELECT status, email, product_name FROM payments WHERE payment_id=$1`, [paymentId]);

		if (checkRows.length > 0 && checkRows[0].status !== 'paid') {
			await pool.query(
				`UPDATE payments SET status='paid', paid_at=CURRENT_TIMESTAMP WHERE payment_id=$1`,
				[paymentId]
			);

			// Disparar requisição para Google Forms
			const emailEnvio = checkRows[0].email;
			const productEnvio = checkRows[0].product_name;

			if (emailEnvio && productEnvio) {
				console.log('Enviando dados para o Google Forms...', { emailEnvio, productEnvio });
				await fetch('https://docs.google.com/forms/u/0/d/e/1FAIpQLScW7nUlq-amwL32xcaGDLc8ditu0VjFCTFzyLsVUoGeMWkjgQ/formResponse', {
					method: 'POST',
					headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
					body: `entry.306960676=${encodeURIComponent(emailEnvio)}&entry.2038387658=${encodeURIComponent(productEnvio)}`
				}).catch(e => console.error('Erro no fetch do forms:', e));
				console.log('Enviado com sucesso para Google Forms!');
			}
			return true;
		}
		return false;
	} catch (err) {
		console.error('Erro em handlePaymentApproved:', err);
		return false;
	}
}

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
				`SELECT payment_id, payment_method FROM payments
				  WHERE status='pending' AND created_at >= NOW() - INTERVAL '${lookbackMin} minutes'
				  ORDER BY created_at DESC
				  LIMIT $1`,
				[batchSize]
			);
			if (!rows || rows.length === 0) return;

			for (const r of rows) {
				const pid = r.payment_id ? String(r.payment_id) : null;
				const method = r.payment_method;
				
				if (!pid) continue;

				// Se o gateway global for AppMax ou o método for cartão ou o ID não for numérico (Mercado Pago), ignora
				if (process.env.CHECKOUT_GATEWAY === 'appmax' || method === 'credit_card' || !/^\d+$/.test(pid)) {
					continue;
				}

				try {
					const details = await withTimeout(
						payment.get({ id: pid }),
						Number(process.env.MP_GET_TIMEOUT_MS || 10000),
						'payment.get'
					);
					const status = (details && details.status) || (details.body && details.body.status);
					if (status === 'approved') {
						const wasApproved = await handlePaymentApproved(pid);
						if (wasApproved) {
							console.log('Poller: pagamento aprovado', { payment_id: pid });
						}
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

// Home - lista de produtos
app.get('/', (req, res) => {
	res.render('home', { products: products.filter(p => p.active !== false) });
});

// Página de todos os produtos
app.get('/produtos', (req, res) => {
	res.render('products_all', { products: products.filter(p => p.active !== false) });
});

// Admin - Login
app.get('/admin/login', (req, res) => {
	if (req.session && req.session.admin) {
		return res.redirect('/admin/produtos');
	}
	res.render('admin_login', { error: null });
});

app.post('/admin/login', (req, res) => {
	const { email, password } = req.body;
	const adminEmail = process.env.ADMIN_LOGIN;
	const adminPass = process.env.ADMIN_PASS;

	if (email === adminEmail && password === adminPass) {
		req.session.admin = true;
		return res.redirect('/admin/produtos');
	}
	res.render('admin_login', { error: 'E-mail ou senha incorretos!', email });
});

app.get('/admin/logout', (req, res) => {
	req.session.destroy();
	res.redirect('/admin/login');
});

// Admin - Dashboard de Produtos
app.get('/admin/produtos', requireAuth, (req, res) => {
	res.render('admin_products', { products });
});

// Admin - Cadastro de Produtos
app.get('/admin/produtos/novo', requireAuth, (req, res) => {
	const nextId = getNextProductId();
	res.render('admin_product_create', { products, nextId });
});

app.post('/admin/produtos', requireAuth, upload.fields([{ name: 'thumbImages', maxCount: 10 }]), (req, res) => {
	const {
		id, name, price, priceBefore, priceUpsell, urlProduto, tutorialVideo, moreInfo,
		development, nameSoft, version, licence, formart, description,
		orderbump, upsell
	} = req.body;

	let thumbPaths = req.body.thumbs ? (Array.isArray(req.body.thumbs) ? req.body.thumbs : [req.body.thumbs]) : [];
	thumbPaths = thumbPaths.map(t => t.trim()).filter(Boolean);

	if (req.files && req.files['thumbImages']) {
		req.files['thumbImages'].forEach(file => {
			thumbPaths.push('produtos/' + file.filename);
		});
	}

	const imagePath = thumbPaths[0] || '';

	let parsedQuestions = [];
	if (req.body.questions && Array.isArray(req.body.questions)) {
		parsedQuestions = req.body.questions;
	} else if (req.body.questions && typeof req.body.questions === 'object') {
		parsedQuestions = Object.values(req.body.questions);
	}

	let parsedPinions = [];
	if (req.body.pinions && Array.isArray(req.body.pinions)) {
		parsedPinions = req.body.pinions;
	} else if (req.body.pinions && typeof req.body.pinions === 'object') {
		parsedPinions = Object.values(req.body.pinions);
	}

	const newProduct = {
		id: id || `PROD${Date.now()}`,
		name: name || '',
		priceBefore: Number(priceBefore) || 0,
		price: Number(price) || 0,
		priceUpsell: priceUpsell ? Number(priceUpsell) : "",
		urlProduto: urlProduto || '',
		tutorialVideo: tutorialVideo || '',
		moreInfo: moreInfo || '',
		image: imagePath || '',
		thumbs: thumbPaths,
		development: development || '',
		nameSoft: nameSoft || '',
		version: version || '',
		licence: licence || '',
		formart: formart || '',
		description: description || '',
		orderbump: orderbump || '',
		upsell: upsell || '',
		relationProducts: [],
		pinions: parsedPinions,
		questions: parsedQuestions
	};

	products.push(newProduct);

	try {
		fs.writeFileSync('./products.json', JSON.stringify(products, null, 2));
		res.redirect('/admin/produtos/novo?success=1');
	} catch (e) {
		console.error(e);
		res.status(500).send('Erro ao salvar produto');
	}
});

// Admin - Edição de Produtos
app.get('/admin/produtos/editar/:id', requireAuth, (req, res) => {
	const product = products.find(p => p.id === req.params.id);
	if (!product) return res.status(404).send('Produto não encontrado');
	res.render('admin_product_edit', { product, products });
});

app.post('/admin/produtos/editar/:id', requireAuth, upload.fields([{ name: 'thumbImages', maxCount: 10 }]), (req, res) => {
	const index = products.findIndex(p => p.id === req.params.id);
	if (index === -1) return res.status(404).send('Produto não encontrado');

	const {
		name, price, priceBefore, priceUpsell, urlProduto, tutorialVideo, moreInfo,
		development, nameSoft, version, licence, formart, description,
		orderbump, upsell
	} = req.body;

	let thumbPaths = req.body.thumbs ? (Array.isArray(req.body.thumbs) ? req.body.thumbs : [req.body.thumbs]) : [];
	thumbPaths = thumbPaths.map(t => t.trim()).filter(Boolean);

	if (req.files && req.files['thumbImages']) {
		req.files['thumbImages'].forEach(file => {
			thumbPaths.push('produtos/' + file.filename);
		});
	}

	const imagePath = thumbPaths[0] || '';

	let parsedQuestions = [];
	if (req.body.questions && Array.isArray(req.body.questions)) {
		parsedQuestions = req.body.questions;
	} else if (req.body.questions && typeof req.body.questions === 'object') {
		parsedQuestions = Object.values(req.body.questions);
	}

	let parsedPinions = [];
	if (req.body.pinions && Array.isArray(req.body.pinions)) {
		parsedPinions = req.body.pinions;
	} else if (req.body.pinions && typeof req.body.pinions === 'object') {
		parsedPinions = Object.values(req.body.pinions);
	}

	products[index] = {
		...products[index],
		name: name || '',
		priceBefore: Number(priceBefore) || 0,
		price: Number(price) || 0,
		priceUpsell: priceUpsell ? Number(priceUpsell) : "",
		urlProduto: urlProduto || '',
		tutorialVideo: tutorialVideo || '',
		moreInfo: moreInfo || '',
		image: imagePath || '',
		thumbs: thumbPaths,
		development: development || '',
		nameSoft: nameSoft || '',
		version: version || '',
		licence: licence || '',
		formart: formart || '',
		description: description || '',
		orderbump: orderbump || '',
		upsell: upsell || '',
		pinions: parsedPinions,
		questions: parsedQuestions
	};

	try {
		fs.writeFileSync('./products.json', JSON.stringify(products, null, 2));
		res.redirect('/admin/produtos?success=2');
	} catch (e) {
		console.error(e);
		res.status(500).send('Erro ao editar produto');
	}
});

// Admin - Upload AJAX para Miniaturas/Imagens
app.post('/admin/upload-ajax', requireAuth, upload.single('imageFile'), (req, res) => {
	if (!req.file) {
		return res.status(400).json({ success: false, error: 'Nenhum arquivo enviado' });
	}
	res.json({ success: true, path: 'produtos/' + req.file.filename });
});

// Admin - Alternar Status (Ativo/Inativo)
app.post('/admin/produtos/status/:id', requireAuth, (req, res) => {
	const index = products.findIndex(p => p.id === req.params.id);
	if (index === -1) return res.status(404).send('Produto não encontrado');

	products[index].active = products[index].active === false ? true : false;

	try {
		fs.writeFileSync('./products.json', JSON.stringify(products, null, 2));
		res.redirect('/admin/produtos');
	} catch (e) {
		console.error(e);
		res.status(500).send('Erro ao alterar status');
	}
});

// Admin - Excluir Produto
app.post('/admin/produtos/excluir/:id', requireAuth, (req, res) => {
	const index = products.findIndex(p => p.id === req.params.id);
	if (index === -1) return res.status(404).send('Produto não encontrado');

	products.splice(index, 1);

	try {
		fs.writeFileSync('./products.json', JSON.stringify(products, null, 2));
		res.redirect('/admin/produtos?success=3');
	} catch (e) {
		console.error(e);
		res.status(500).send('Erro ao excluir produto');
	}
});

// Página de detalhe do produto com formulário de e-mail
app.get('/produto/:id', (req, res) => {
	const { id } = req.params;
	const activeProducts = products.filter(p => p.active !== false);
	const product = activeProducts.find(p => p.id === id);
	if (!product) return res.status(404).send('Produto não encontrado');

	let relatedProducts = [];
	if (product.relationProducts && product.relationProducts.length > 0) {
		relatedProducts = activeProducts.filter(p => product.relationProducts.includes(p.id));
	} else {
		// Pega até 4 produtos diferentes do atual de forma aleatória
		const otherProducts = activeProducts.filter(p => p.id !== product.id);
		const shuffled = [...otherProducts].sort(() => 0.5 - Math.random());
		relatedProducts = shuffled.slice(0, 4);
	}

	const orderbumpProduct = product.orderbump ? activeProducts.find(p => p.id === product.orderbump) : null;

	res.render('product_detail', { product, relatedProducts, orderbumpProduct });
});

// Helper para criar PIX e persistir
async function createPixAndPersist({ amount, description, targetUrl, payer, email, productUrl, whatsapp, productName }) {
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
	const finalTarget = targetUrl || `/funil/${accessToken}`;
	await pool.query(
		`INSERT INTO payments (payment_id, amount, description, target_url, access_token, status, email, product_url, whatsapp, product_name)
		 VALUES ($1, $2, $3, $4, $5, 'pending', $6, $7, $8, $9)`,
		[paymentId.toString(), Math.round(transactionAmount * 100), description, finalTarget, accessToken, email || null, productUrl || null, whatsapp || null, productName || null]
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
		const whatsapp = (req.body && req.body.whatsapp) ? String(req.body.whatsapp).trim() : '';
		const cpf = (req.body && req.body.cpf) ? String(req.body.cpf).replace(/\D/g, '') : '';
		const orderbumpId = (req.body && req.body.orderbumpId) ? String(req.body.orderbumpId) : null;

		const product = products.find(p => p.id === id && p.active !== false);
		if (!product) return res.status(404).send('Produto não encontrado');
		if (!email) return res.status(400).send('E-mail é obrigatório');

		let amount = product.price;
		let description = product.name;

		if (orderbumpId) {
			const bumpProduct = products.find(p => p.id === orderbumpId && p.active !== false);
			if (bumpProduct) {
				amount += bumpProduct.price;
				description += ' + ' + bumpProduct.name;
			}
		}

		// Se o gateway configurado for AppMax
		if (process.env.CHECKOUT_GATEWAY === 'appmax') {
			const accessToken = generateAccessToken();
			const finalTarget = `/funil/${accessToken}`;
			await pool.query(
				`INSERT INTO payments (amount, description, target_url, access_token, status, email, product_url, whatsapp, product_name)
				 VALUES ($1, $2, $3, $4, 'pending', $5, $6, $7, $8)`,
				[Math.round(amount * 100), description, finalTarget, accessToken, email || null, product.urlProduto || null, whatsapp || null, (product.nameSoft || product.name) || null]
			);
			return res.redirect(`/checkout/${accessToken}`);
		}

		// Fluxo Legado: Mercado Pago
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
			amount,
			description,
			targetUrl: null,
			payer,
			email,
			productUrl: product.urlProduto,
			whatsapp,
			productName: product.nameSoft || product.name
		});
		return res.render('checkout', { data, product, amount, description });
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

// GET /checkout/:token - Renderiza tela de pagamento do AppMax
app.get('/checkout/:token', async (req, res) => {
	try {
		const { token } = req.params;
		const { rows } = await pool.query(
			`SELECT * FROM payments WHERE access_token = $1`,
			[token]
		);
		const row = rows[0];
		if (!row) return res.status(404).send('Token de checkout inválido');

		const product = products.find(p => p.nameSoft === row.product_name || p.name === row.product_name);
		if (!product) return res.status(404).send('Produto não encontrado');

		return res.render('checkout_payment', {
			payment: row,
			product,
			amount: row.amount / 100,
			token
		});
	} catch (err) {
		console.error('Erro ao carregar checkout:', err);
		return res.status(500).send('Erro ao carregar checkout');
	}
});

// POST /checkout/pix/:token - Cria o pagamento Pix na AppMax via AJAX
app.post('/checkout/pix/:token', async (req, res) => {
	try {
		const { token } = req.params;
		const { rows } = await pool.query(
			`SELECT * FROM payments WHERE access_token = $1`,
			[token]
		);
		const row = rows[0];
		if (!row) return res.status(404).json({ error: 'Checkout não encontrado' });

		const product = products.find(p => p.nameSoft === row.product_name || p.name === row.product_name);
		if (!product) return res.status(404).json({ error: 'Produto não encontrado' });

		const amount = row.amount / 100;

		// 1. Cadastra Cliente na AppMax
		const customerId = await appmaxService.createCustomer({
			name: row.email.split('@')[0],
			email: row.email,
			phone: row.whatsapp || '',
			document_number: req.body.cpf || ''
		});

		// 2. Cria o Pedido na AppMax
		const orderId = await appmaxService.createOrder({
			customer_id: customerId,
			product: {
				id: product.id,
				name: product.nameSoft || product.name
			},
			amount: amount
		});

		// 3. Processa Pagamento Pix na AppMax
		const pixResult = await appmaxService.createPixPayment({
			order_id: orderId,
			customer_id: customerId,
			document_number: req.body.cpf || ''
		});

		// Atualiza o banco de dados local
		await pool.query(
			`UPDATE payments SET payment_id = $1, payment_method = 'pix' WHERE access_token = $2`,
			[pixResult.payment_id.toString(), token]
		);

		return res.json({
			success: true,
			payment_id: pixResult.payment_id,
			qr_code: pixResult.qr_code,
			qr_code_base64: pixResult.qr_code_base64,
			status: pixResult.status,
			acesso_url: `/acesso/${token}`,
			status_url: `/status/${pixResult.payment_id}`
		});
	} catch (err) {
		console.error('Erro ao gerar Pix no checkout:', err.message);
		return res.status(500).json({ error: err.message || 'Erro ao gerar Pix' });
	}
});

// POST /checkout/card/:token - Cria pagamento de Cartão de Crédito na AppMax via AJAX
app.post('/checkout/card/:token', async (req, res) => {
	try {
		const { token } = req.params;
		const {
			cardName,
			cardNumber,
			cardCvv,
			cardMonth,
			cardYear,
			installments,
			cpf
		} = req.body;

		const { rows } = await pool.query(
			`SELECT * FROM payments WHERE access_token = $1`,
			[token]
		);
		const row = rows[0];
		if (!row) return res.status(404).json({ error: 'Checkout não encontrado' });

		const product = products.find(p => p.nameSoft === row.product_name || p.name === row.product_name);
		if (!product) return res.status(404).json({ error: 'Produto não encontrado' });

		const amount = row.amount / 100;

		// 1. Cadastra Cliente na AppMax
		const customerId = await appmaxService.createCustomer({
			name: cardName || row.email.split('@')[0],
			email: row.email,
			phone: row.whatsapp || '',
			document_number: cpf || ''
		});

		// 2. Cria o Pedido na AppMax
		const orderId = await appmaxService.createOrder({
			customer_id: customerId,
			product: {
				id: product.id,
				name: product.nameSoft || product.name
			},
			amount: amount
		});

		// 3. Tokeniza o cartão na AppMax
		const cardToken = await appmaxService.tokenizeCard({
			name: cardName,
			number: cardNumber,
			cvv: cardCvv,
			month: cardMonth,
			year: cardYear
		});

		// 4. Executa Pagamento no Cartão
		const cardResult = await appmaxService.createCardPayment({
			order_id: orderId,
			customer_id: customerId,
			token: cardToken,
			cvv: cardCvv,
			installments: installments,
			document_number: cpf
		});

		// Atualiza banco de dados local
		await pool.query(
			`UPDATE payments SET payment_id = $1, payment_method = 'credit_card' WHERE access_token = $2`,
			[cardResult.payment_id.toString(), token]
		);

		// Se o status retornado for aprovado/autorizado, marca como pago imediatamente e finaliza
		if (cardResult.status === 'approved' || cardResult.status === 'paid' || cardResult.status === 'authorized') {
			await handlePaymentApproved(cardResult.payment_id.toString());
			return res.json({
				success: true,
				status: 'paid',
				acesso_url: `/acesso/${token}`
			});
		} else {
			return res.json({
				success: false,
				status: cardResult.status || 'pending',
				message: 'O pagamento está em análise ou foi recusado pela operadora do cartão.'
			});
		}
	} catch (err) {
		console.error('Erro ao processar cartão no checkout:', err.message);
		return res.status(500).json({ error: err.message || 'Erro ao processar pagamento' });
	}
});


// Rota do funil (Upsell ou Tutorial)
app.get('/funil/:token', async (req, res) => {
	try {
		const { token } = req.params;
		const { rows } = await pool.query(
			`SELECT payment_id, status, email, product_name FROM payments WHERE access_token=$1`,
			[token]
		);
		const row = rows[0];
		if (!row) return res.status(404).send('Token inválido');
		if (row.status !== 'paid') return res.status(402).send('Pagamento ainda não confirmado');

		// Acha o produto comprado
		const product = products.find(p => p.nameSoft === row.product_name || p.name === row.product_name);

		if (product && product.upsell) {
			const upsellProduct = products.find(p => p.id === product.upsell && p.active !== false);
			if (upsellProduct) {
				return res.render('upsell', { token, upsellProduct, product, email: row.email, whatsapp: row.whatsapp });
			}
		}

		// Se não tem upsell, joga pro tutorial
		return res.redirect(`/tutorial/${product.id}`);
	} catch (err) {
		return res.status(500).send('Erro ao carregar página de funil.');
	}
});

// Tutorial route (Pública)
app.get('/tutorial/:id', (req, res) => {
	try {
		const { id } = req.params;
		const product = products.find(p => p.id === id && p.active !== false);

		if (!product) return res.status(404).send('Produto ou tutorial não encontrado');

		return res.render('tutorial', { product, products: products.filter(p => p.active !== false) });
	} catch (err) {
		return res.status(500).send('Erro ao carregar tutorial.');
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
				await handlePaymentApproved(id.toString());
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

// POST /webhook/appmax - recebe eventos e confirma status da AppMax
app.post('/webhook/appmax', async (req, res) => {
	try {
		console.log('Recebendo webhook da AppMax...', req.body);
		const body = req.body || {};
		const status = body.status || (body.data && body.data.status);
		const paymentId = body.id || body.payment_id || (body.data && body.data.id) || (body.data && body.data.order_id);

		if (paymentId) {
			const isApproved = ['aprovado', 'approved', 'pago', 'paid', 'autorizado', 'authorized'].includes(String(status).toLowerCase());
			if (isApproved) {
				console.log(`Webhook AppMax - Aprovando pagamento ${paymentId}`);
				await handlePaymentApproved(paymentId.toString());
			}
		}

		return res.status(200).json({ received: true });
	} catch (err) {
		console.error('Erro no webhook da AppMax:', err);
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