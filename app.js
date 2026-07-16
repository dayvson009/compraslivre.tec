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

function dbProductToJsProduct(row) {
	if (!row) return null;
	return {
		id: row.id,
		name: row.name,
		priceBefore: row.price_before ? Number(row.price_before) : 0,
		price: Number(row.price),
		priceUpsell: row.price_upsell ? Number(row.price_upsell) : '',
		urlProduto: row.url_produto || '',
		tutorialVideo: row.tutorial_video || '',
		moreInfo: row.more_info || '',
		image: row.image || '',
		thumbs: typeof row.thumbs === 'string' ? JSON.parse(row.thumbs) : (row.thumbs || []),
		development: row.development || '',
		nameSoft: row.name_soft || '',
		version: row.version || '',
		licence: row.licence || '',
		formart: row.formart || '',
		description: row.description || '',
		orderbump: row.orderbump || '',
		upsell: row.upsell || '',
		relationProducts: typeof row.relation_products === 'string' ? JSON.parse(row.relation_products) : (row.relation_products || []),
		pinions: typeof row.pinions === 'string' ? JSON.parse(row.pinions) : (row.pinions || []),
		questions: typeof row.questions === 'string' ? JSON.parse(row.questions) : (row.questions || []),
		active: row.active !== false,
		emailMessage: row.email_message || '',
		categoryId: row.category_id || null,
		systemType: row.system_type || ''
	};
}

async function getAllProducts() {
	const { rows } = await pool.query(`
		SELECT p.*, c.name as category_name 
		FROM products p
		LEFT JOIN categories c ON p.category_id = c.id
		ORDER BY p.id ASC
	`);
	return rows.map(row => {
		const p = dbProductToJsProduct(row);
		if (p) p.categoryName = row.category_name || '';
		return p;
	});
}

async function getActiveProducts() {
	const { rows } = await pool.query(`
		SELECT p.*, c.name as category_name 
		FROM products p
		LEFT JOIN categories c ON p.category_id = c.id
		WHERE p.active = true 
		ORDER BY p.id ASC
	`);
	return rows.map(row => {
		const p = dbProductToJsProduct(row);
		if (p) p.categoryName = row.category_name || '';
		return p;
	});
}

async function getProductById(id) {
	if (!id) return null;
	const { rows } = await pool.query(`
		SELECT p.*, c.name as category_name 
		FROM products p
		LEFT JOIN categories c ON p.category_id = c.id
		WHERE p.id = $1
	`, [id]);
	if (rows.length === 0) return null;
	const p = dbProductToJsProduct(rows[0]);
	if (p) p.categoryName = rows[0].category_name || '';
	return p;
}

async function getAllCategories() {
	const { rows } = await pool.query('SELECT * FROM categories ORDER BY name ASC');
	return rows;
}

async function getNextProductId() {
	const { rows } = await pool.query('SELECT id FROM products ORDER BY id DESC LIMIT 1');
	if (rows.length === 0) return 'MLB2026030301';
	const lastId = rows[0].id;

	// Extrai a parte numérica do final do ID
	const match = lastId.match(/^(.*?)(\d+)$/);
	if (!match) return 'MLB2026030301';

	const prefix = match[1];
	const numberStr = match[2];
	const nextNumber = parseInt(numberStr) + 1;

	// Mantém o preenchimento de zeros à esquerda
	return prefix + nextNumber.toString().padStart(numberStr.length, '0');
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

// Middleware de identificação do Tenant/Loja
app.use(async (req, res, next) => {
	if (req.path.startsWith('/images') || req.path.startsWith('/js') || req.path.startsWith('/css')) {
		return next();
	}
	try {
		const host = req.headers.host || '';
		let slug = host.split('.')[0];
		const devSlugs = ['localhost', 'seusprogramas', '127', '0'];
		const isDev = devSlugs.some(ds => slug.toLowerCase().includes(ds));
		if (isDev || req.query.loja) {
			slug = req.query.loja || 'compraslivre';
		}
		const { rows } = await pool.query('SELECT * FROM stores WHERE slug = $1', [slug.toLowerCase()]);
		let store = rows[0];
		if (!store) {
			const { rows: defaultRows } = await pool.query('SELECT * FROM stores WHERE slug = $1', ['compraslivre']);
			store = defaultRows[0];
		}
		if (!store) {
			const { rows: firstStoreRows } = await pool.query('SELECT * FROM stores ORDER BY id ASC LIMIT 1');
			store = firstStoreRows[0];
		}
		if (!store) {
			return res.status(404).send('Loja (Tenant) não configurada.');
		}
		req.store = store;
		res.locals.store = store;
		next();
	} catch (e) {
		console.error('Erro no middleware de tenant:', e);
		next(e);
	}
});

// Middleware para injetar informações de sessão no locals do painel administrativo
app.use('/admin', (req, res, next) => {
	if (req.session && req.session.admin) {
		res.locals.userRole = req.session.userRole || 'subadmin';
		res.locals.userStoreSlug = req.session.userStoreSlug || '';
	} else {
		res.locals.userRole = undefined;
		res.locals.userStoreSlug = undefined;
	}
	next();
});

// Middleware de helper global para imagens
app.use((req, res, next) => {
	res.locals.getImageUrl = function (imagePath) {
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

// Middleware de autenticação para Administrador Global
function requireGlobalAdmin(req, res, next) {
	if (req.session && req.session.admin && req.session.userRole === 'admin') {
		return next();
	}
	return res.status(403).send('Acesso restrito ao administrador global.');
}

// DB Postgres
let pgHost = process.env.PGHOST;
if (pgHost === 'db' && !fs.existsSync('/.dockerenv') && !process.env.DOCKER_ENV) {
	pgHost = 'localhost';
}

const pool = new Pool(process.env.DATABASE_URL ? {
	connectionString: process.env.DATABASE_URL,
	ssl: process.env.PGSSLMODE === 'require' ? { rejectUnauthorized: false } : undefined
} : {
	host: pgHost,
	port: Number(process.env.PGPORT),
	user: process.env.PGUSER,
	password: process.env.PGPASSWORD,
	database: process.env.PGDATABASE
});

async function initSchema() {
	// 1. Tabela de Lojas (Tenants)
	await pool.query(`
		CREATE TABLE IF NOT EXISTS stores (
			id SERIAL PRIMARY KEY,
			slug TEXT UNIQUE NOT NULL,
			name TEXT NOT NULL,
			logo_url TEXT,
			mp_access_token TEXT NOT NULL,
			resend_api_key TEXT,
			resend_from TEXT,
			created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
		);
	`);

	// 2. Tabela de Usuários (Diferenciando Admin de Subadmin)
	await pool.query(`
		CREATE TABLE IF NOT EXISTS users (
			id SERIAL PRIMARY KEY,
			email TEXT UNIQUE NOT NULL,
			password TEXT NOT NULL,
			role TEXT NOT NULL DEFAULT 'subadmin', -- 'admin' ou 'subadmin'
			store_slug TEXT, -- Se for subadmin, indica a loja dele
			created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
		);
	`);

	// 2.5 Tabela de Categorias
	await pool.query(`
		CREATE TABLE IF NOT EXISTS categories (
			id SERIAL PRIMARY KEY,
			name TEXT NOT NULL UNIQUE
		);
	`);

	// 3. Tabela de Produtos (Migração do products.json)
	await pool.query(`
		CREATE TABLE IF NOT EXISTS products (
			id TEXT PRIMARY KEY,
			name TEXT NOT NULL,
			price_before NUMERIC DEFAULT 0,
			price NUMERIC NOT NULL,
			price_upsell NUMERIC,
			url_produto TEXT,
			tutorial_video TEXT,
			more_info TEXT,
			image TEXT,
			thumbs JSONB DEFAULT '[]'::jsonb,
			development TEXT,
			name_soft TEXT,
			version TEXT,
			licence TEXT,
			formart TEXT,
			description TEXT,
			orderbump TEXT,
			upsell TEXT,
			relation_products JSONB DEFAULT '[]'::jsonb,
			pinions JSONB DEFAULT '[]'::jsonb,
			questions JSONB DEFAULT '[]'::jsonb,
			active BOOLEAN DEFAULT TRUE,
			email_message TEXT,
			created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
		);
	`);

	// Alterações incrementais na tabela de produtos
	await pool.query(`ALTER TABLE products ADD COLUMN IF NOT EXISTS category_id INTEGER REFERENCES categories(id) ON DELETE SET NULL;`);
	await pool.query(`ALTER TABLE products ADD COLUMN IF NOT EXISTS system_type TEXT;`);

	// 4. Tabela de Pagamentos
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

	// Alterações incrementais na tabela de pagamentos
	await pool.query(`ALTER TABLE payments ADD COLUMN IF NOT EXISTS email TEXT;`);
	await pool.query(`ALTER TABLE payments ADD COLUMN IF NOT EXISTS access_password TEXT;`);
	await pool.query(`ALTER TABLE payments ADD COLUMN IF NOT EXISTS product_url TEXT;`);
	await pool.query(`ALTER TABLE payments ADD COLUMN IF NOT EXISTS whatsapp TEXT;`);
	await pool.query(`ALTER TABLE payments ADD COLUMN IF NOT EXISTS product_name TEXT;`);
	await pool.query(`ALTER TABLE payments ADD COLUMN IF NOT EXISTS payment_method TEXT;`);
	await pool.query(`ALTER TABLE payments ADD COLUMN IF NOT EXISTS store_slug TEXT;`);

	// Índices úteis
	await pool.query(`CREATE INDEX IF NOT EXISTS idx_payments_status_created ON payments (status, created_at DESC);`);
	await pool.query(`CREATE INDEX IF NOT EXISTS idx_payments_store ON payments (store_slug);`);
	// Alterações incrementais na tabela de lojas
	await pool.query(`ALTER TABLE stores ADD COLUMN IF NOT EXISTS resend_api_key TEXT;`);
	await pool.query(`ALTER TABLE stores ADD COLUMN IF NOT EXISTS resend_from TEXT;`);
	await pool.query(`ALTER TABLE stores ADD COLUMN IF NOT EXISTS banner_product_id TEXT;`);
	await pool.query(`ALTER TABLE stores ADD COLUMN IF NOT EXISTS banner_background_image TEXT;`);
	await pool.query(`ALTER TABLE stores ADD COLUMN IF NOT EXISTS banner_title TEXT;`);
	await pool.query(`ALTER TABLE stores ADD COLUMN IF NOT EXISTS banner_subtitle TEXT;`);
	await pool.query(`ALTER TABLE stores ADD COLUMN IF NOT EXISTS banner_timer_hours INTEGER DEFAULT 8;`);

	// --- SEED DE DADOS INICIAIS ---

	// Se não existirem categorias, insere as categorias padrão
	const { rows: catCountRows } = await pool.query('SELECT count(*) FROM categories');
	if (parseInt(catCountRows[0].count) === 0) {
		console.log('Sem categorias no banco. Criando categorias padrão...');
		const defaultCats = [
			'Engenharia e Arquitetura',
			'Design e Edição',
			'Escritório',
			'Marcenaria',
			'Eletronica'
		];
		for (const catName of defaultCats) {
			await pool.query('INSERT INTO categories (name) VALUES ($1) ON CONFLICT (name) DO NOTHING', [catName]);
		}
	}

	// Se não existirem lojas, insere a loja padrão do .env
	const { rows: storeRows } = await pool.query('SELECT count(*) FROM stores');
	if (parseInt(storeRows[0].count) === 0) {
		console.log('Sem lojas no banco. Criando loja padrão: compraslivre');
		await pool.query(
			`INSERT INTO stores (slug, name, mp_access_token, resend_api_key, resend_from)
			 VALUES ($1, $2, $3, $4, $5)`,
			[
				'compraslivre',
				'Compras Livre',
				process.env.MP_ACCESS_TOKEN || 'TEST-XXXXXXXXXX',
				process.env.RESEND_API_KEY || '',
				process.env.RESEND_FROM || ''
			]
		);
	}

	// Se não existirem usuários, insere o administrador do .env
	const { rows: userRows } = await pool.query('SELECT count(*) FROM users');
	if (parseInt(userRows[0].count) === 0 && process.env.ADMIN_LOGIN && process.env.ADMIN_PASS) {
		console.log('Sem usuários no banco. Criando administrador padrão.');
		await pool.query(
			`INSERT INTO users (email, password, role)
			 VALUES ($1, $2, $3)`,
			[process.env.ADMIN_LOGIN, process.env.ADMIN_PASS, 'admin']
		);
	}

	// Se não existirem produtos, migrar automaticamente de products.json
	const { rows: productRows } = await pool.query('SELECT count(*) FROM products');
	if (parseInt(productRows[0].count) === 0) {
		console.log('Sem produtos no banco de dados. Iniciando migração do products.json...');
		try {
			if (fs.existsSync('./products.json')) {
				const rawProducts = JSON.parse(fs.readFileSync('./products.json', 'utf8'));
				for (const p of rawProducts) {
					await pool.query(
						`INSERT INTO products (
							id, name, price_before, price, price_upsell, url_produto, tutorial_video, more_info,
							image, thumbs, development, name_soft, version, licence, formart, description,
							orderbump, upsell, relation_products, pinions, questions, active, email_message
						) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23)
						ON CONFLICT (id) DO NOTHING`,
						[
							p.id,
							p.name || '',
							Number(p.priceBefore) || 0,
							Number(p.price) || 0,
							p.priceUpsell ? Number(p.priceUpsell) : null,
							p.urlProduto || '',
							p.tutorialVideo || '',
							p.moreInfo || '',
							p.image || '',
							JSON.stringify(p.thumbs || []),
							p.development || '',
							p.nameSoft || '',
							p.version || '',
							p.licence || '',
							p.formart || '',
							p.description || '',
							p.orderbump || '',
							p.upsell || '',
							JSON.stringify(p.relationProducts || []),
							JSON.stringify(p.pinions || []),
							JSON.stringify(p.questions || []),
							p.active !== false,
							p.emailMessage || ''
						]
					);
				}
				console.log(`Migração concluída com sucesso! ${rawProducts.length} produtos migrados.`);
			}
		} catch (e) {
			console.error('Falha ao migrar products.json para Postgres:', e);
		}
	}
}
initSchema().catch(err => {
	console.error('Erro ao inicializar schema Postgres:', err);
	process.exit(1);
});

// Função para enviar e-mail de entrega através do Resend
async function sendPurchaseEmail(email, purchasedProducts, store) {
	const resendKey = (store && store.resend_api_key) || process.env.RESEND_API_KEY;
	const resendFrom = (store && store.resend_from) || process.env.RESEND_FROM;

	if (!resendKey || !resendFrom) {
		console.warn('Resend API Key ou From não configurados para a loja/global. Ignorando envio de e-mail.');
		return;
	}

	try {
		let emailContent = '';
		for (const product of purchasedProducts) {
			const msg = product.emailMessage || product.moreInfo || 'Obrigado por comprar conosco! Seu produto foi liberado.';
			emailContent += `
				<div style="margin-bottom: 30px; border-bottom: 1px solid #e2e8f0; padding-bottom: 20px;">
					<h3 style="color: #2563eb; font-size: 18px; margin-top: 0;">${product.name}</h3>
					<div style="white-space: pre-wrap; font-size: 15px; line-height: 1.6; color: #334155; margin-bottom: 15px;">${msg}</div>
					${product.tutorialVideo ? `<p style="margin-top: 15px;"><a href="${product.tutorialVideo}" style="display: inline-block; padding: 10px 20px; background-color: #2563eb; color: #ffffff; text-decoration: none; border-radius: 6px; font-weight: bold; font-size: 14px;">Assistir Vídeo Tutorial</a></p>` : ''}
				</div>
			`;
		}

		const html = `
			<div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; color: #1e293b; border: 1px solid #e2e8f0; border-radius: 8px;">
				<h2 style="color: #0f172a; font-size: 22px; border-bottom: 2px solid #2563eb; padding-bottom: 10px; margin-top: 0;">Sua compra foi aprovada! 🎉</h2>
				<p style="font-size: 16px; line-height: 1.5; color: #475569;">Olá! Obrigado por comprar na ${(store && store.name) || 'nossa loja'}.</p>
				<p style="font-size: 16px; line-height: 1.5; color: #475569;">Aqui estão as instruções de acesso para o seu produto:</p>
				<div style="margin-top: 25px;">
					${emailContent}
				</div>
				<p style="margin-top: 30px; font-size: 13px; color: #64748b; border-top: 1px solid #e2e8f0; padding-top: 15px;">
					Se você tiver qualquer dúvida ou precisar de ajuda com a instalação, responda a este e-mail. Nossa equipe está à disposição.
				</p>
			</div>
		`;

		const subject = purchasedProducts.length === 1
			? `Seu acesso ao produto foi liberado: ${purchasedProducts[0].name}`
			: `Seus acessos aos produtos foram liberados!`;

		console.log(`Disparando e-mail de compra para ${email} via Resend...`);
		const response = await fetch('https://api.resend.com/emails', {
			method: 'POST',
			headers: {
				'Authorization': `Bearer ${resendKey}`,
				'Content-Type': 'application/json'
			},
			body: JSON.stringify({
				from: resendFrom,
				to: [email],
				subject: subject,
				html: html
			})
		});

		const data = await response.json();
		if (response.ok) {
			console.log('E-mail enviado com sucesso via Resend:', data);
		} else {
			console.error('Falha no envio de e-mail pelo Resend:', data);
		}
	} catch (error) {
		console.error('Erro na requisição para o Resend:', error.message || error);
	}
}

// Helper para processar aprovação de pagamento e enviar para Google Forms e Resend
async function handlePaymentApproved(paymentId) {
	try {
		const { rows: checkRows } = await pool.query(`SELECT status, email, product_name, description, store_slug FROM payments WHERE payment_id=$1`, [paymentId]);

		if (checkRows.length > 0 && checkRows[0].status !== 'paid') {
			await pool.query(
				`UPDATE payments SET status='paid', paid_at=CURRENT_TIMESTAMP WHERE payment_id=$1`,
				[paymentId]
			);

			// Disparar requisição para Google Forms
			const emailEnvio = checkRows[0].email;
			const productEnvio = checkRows[0].product_name;
			const descriptionEnvio = checkRows[0].description;
			const storeSlugEnvio = checkRows[0].store_slug;

			if (emailEnvio && productEnvio) {
				console.log('Enviando dados para o Google Forms...', { emailEnvio, productEnvio });
				await fetch('https://docs.google.com/forms/u/0/d/e/1FAIpQLScW7nUlq-amwL32xcaGDLc8ditu0VjFCTFzyLsVUoGeMWkjgQ/formResponse', {
					method: 'POST',
					headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
					body: `entry.306960676=${encodeURIComponent(emailEnvio)}&entry.2038387658=${encodeURIComponent(productEnvio)}`
				}).catch(e => console.error('Erro no fetch do forms:', e));
				console.log('Enviado com sucesso para Google Forms!');
			}

			// Disparar envio do e-mail de entrega via Resend
			if (emailEnvio) {
				const activeProducts = await getActiveProducts();
				const purchasedProducts = activeProducts.filter(p => {
					if (p.nameSoft === productEnvio || p.name === productEnvio) return true;
					if (descriptionEnvio && descriptionEnvio.includes(p.name)) return true;
					return false;
				});
				if (purchasedProducts.length > 0) {
					let store = null;
					if (storeSlugEnvio) {
						const { rows: storeRows } = await pool.query('SELECT name, resend_api_key, resend_from FROM stores WHERE slug = $1', [storeSlugEnvio]);
						if (storeRows.length > 0) {
							store = storeRows[0];
						}
					}
					sendPurchaseEmail(emailEnvio, purchasedProducts, store).catch(e => console.error('Erro ao enviar e-mail de compra:', e));
				}
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
				`SELECT payment_id, payment_method, store_slug FROM payments
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

				// Se o método for cartão ou o ID não for numérico (Mercado Pago), ignora
				if (method === 'credit_card' || !pid || !/^\d+$/.test(pid)) {
					continue;
				}

				try {
					let token = process.env.MP_ACCESS_TOKEN;
					if (r.store_slug) {
						const { rows: storeRows } = await pool.query('SELECT mp_access_token FROM stores WHERE slug = $1', [r.store_slug]);
						if (storeRows.length > 0) {
							token = storeRows[0].mp_access_token;
						}
					}
					const paymentClient = getPaymentInstance(token);
					const details = await withTimeout(
						paymentClient.get({ id: pid }),
						Number(process.env.MP_GET_TIMEOUT_MS || 10000),
						'paymentClient.get'
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
// Mercado Pago SDK Dinâmico por Tenant
function getPaymentInstance(accessToken) {
	const tokenToUse = accessToken || process.env.MP_ACCESS_TOKEN || 'TEST-XXXXXXXXXX';
	const client = new MercadoPagoConfig({ accessToken: tokenToUse });
	return new Payment(client);
}

// Util: gera token curto para acesso
function generateAccessToken() {
	return crypto.randomBytes(12).toString('hex');
}

function generatePassword() {
	return crypto.randomBytes(6).toString('base64').replace(/[^a-zA-Z0-9]/g, '').slice(0, 10);
}

// Auxiliar para detectar bandeira do cartão para o Mercado Pago
function getCardBrand(cardNumber) {
	const clean = cardNumber.replace(/\D/g, '');
	if (/^4/.test(clean)) {
		if (/^(401178|401179|431274|438935|451416|457393|457631|457632)/.test(clean)) {
			return 'elo';
		}
		return 'visa';
	}
	if (/^5[1-5]/.test(clean) || /^222[1-9]/.test(clean) || /^22[3-9]/.test(clean) || /^2[3-6]/.test(clean) || /^27[0-1]/.test(clean) || /^2720/.test(clean)) {
		if (/^(506699|5067|5090|504175)/.test(clean)) {
			return 'elo';
		}
		return 'master';
	}
	if (/^3[47]/.test(clean)) {
		return 'amex';
	}
	if (/^(606282|3841)/.test(clean)) {
		return 'hipercard';
	}
	if (/^(506699|5090|504175|636368|636297|5067|4576|4011|438935|457631|457632|431274|627780)/.test(clean)) {
		return 'elo';
	}
	if (/^3(?:0[0-5]|[68])/.test(clean)) {
		return 'diners';
	}
	return 'visa'; // fallback
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
app.get('/', async (req, res) => {
	const activeProducts = await getActiveProducts();
	res.render('home', { products: activeProducts });
});

// Página de todos os produtos
app.get('/produtos', async (req, res) => {
	try {
		const { q, category, system } = req.query;
		let queryText = `
			SELECT p.*, c.name as category_name 
			FROM products p
			LEFT JOIN categories c ON p.category_id = c.id
			WHERE p.active = true
		`;
		const queryParams = [];

		if (q && q.trim()) {
			queryParams.push(`%${q.trim()}%`);
			queryText += ` AND (p.name ILIKE $${queryParams.length} OR p.description ILIKE $${queryParams.length} OR p.name_soft ILIKE $${queryParams.length} OR p.development ILIKE $${queryParams.length})`;
		}

		if (category) {
			queryParams.push(parseInt(category));
			queryText += ` AND p.category_id = $${queryParams.length}`;
		}

		if (system) {
			if (system === 'Windows') {
				queryText += ` AND (p.system_type = 'Windows' OR p.system_type = 'Ambos')`;
			} else if (system === 'Mac') {
				queryText += ` AND (p.system_type = 'Mac' OR p.system_type = 'Ambos')`;
			}
		}

		queryText += ` ORDER BY p.id ASC`;

		const { rows } = await pool.query(queryText, queryParams);
		const products = rows.map(row => {
			const p = dbProductToJsProduct(row);
			if (p) p.categoryName = row.category_name || '';
			return p;
		});

		const categories = await getAllCategories();

		res.render('products_all', {
			products,
			categories,
			filters: { q: q || '', category: category || '', system: system || '' }
		});
	} catch (e) {
		console.error(e);
		res.status(500).send('Erro ao carregar catálogo de produtos.');
	}
});

// Termos de Uso
app.get('/termos', (req, res) => {
	res.render('termos');
});

// Política de Privacidade
app.get('/privacidade', (req, res) => {
	res.render('privacidade');
});


// Admin - Login
app.get('/admin/login', (req, res) => {
	if (req.session && req.session.admin) {
		return res.redirect('/admin/produtos');
	}
	res.render('admin_login', { error: null });
});

app.post('/admin/login', async (req, res) => {
	const { email, password } = req.body;
	try {
		const { rows } = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
		const user = rows[0];

		if (user && user.password === password) {
			req.session.admin = true;
			req.session.userId = user.id;
			req.session.userRole = user.role;
			req.session.userStoreSlug = user.store_slug;
			return res.redirect('/admin/produtos');
		}
		res.render('admin_login', { error: 'E-mail ou senha incorretos!', email });
	} catch (e) {
		console.error(e);
		res.render('admin_login', { error: 'Erro no servidor. Tente novamente.', email });
	}
});

app.get('/admin/logout', (req, res) => {
	req.session.destroy();
	res.redirect('/admin/login');
});

// Admin - Gerenciamento de Lojas (Tenants) e Subadmins (Apenas Administrador Global)
app.get('/admin/lojas', requireAuth, requireGlobalAdmin, async (req, res) => {
	try {
		const { rows: stores } = await pool.query('SELECT * FROM stores ORDER BY slug ASC');
		const { rows: users } = await pool.query('SELECT * FROM users ORDER BY email ASC');
		res.render('admin_stores', { stores, users });
	} catch (e) {
		console.error(e);
		res.status(500).send('Erro ao carregar lojas e usuários.');
	}
});

app.post('/admin/lojas', requireAuth, requireGlobalAdmin, async (req, res) => {
	const { slug, name, mp_access_token, logo_url } = req.body;
	try {
		await pool.query(
			`INSERT INTO stores (slug, name, mp_access_token, logo_url)
			 VALUES ($1, $2, $3, $4)
			 ON CONFLICT (slug) DO UPDATE 
			 SET name = EXCLUDED.name, mp_access_token = EXCLUDED.mp_access_token, 
			     logo_url = EXCLUDED.logo_url`,
			[slug.toLowerCase().trim(), name, mp_access_token, logo_url || null]
		);
		res.redirect('/admin/lojas');
	} catch (e) {
		console.error(e);
		res.status(500).send('Erro ao cadastrar loja.');
	}
});

app.post('/admin/lojas/editar', requireAuth, requireGlobalAdmin, async (req, res) => {
	const { id, slug, name, mp_access_token, logo_url } = req.body;
	try {
		await pool.query(
			`UPDATE stores SET slug = $1, name = $2, mp_access_token = $3, logo_url = $4 WHERE id = $5`,
			[slug.toLowerCase().trim(), name, mp_access_token, logo_url || null, id]
		);
		res.redirect('/admin/lojas');
	} catch (e) {
		console.error(e);
		res.status(500).send('Erro ao editar loja.');
	}
});

app.post('/admin/lojas/excluir/:id', requireAuth, requireGlobalAdmin, async (req, res) => {
	try {
		await pool.query('DELETE FROM stores WHERE id = $1', [req.params.id]);
		res.redirect('/admin/lojas');
	} catch (e) {
		console.error(e);
		res.status(500).send('Erro ao excluir loja.');
	}
});

app.post('/admin/usuarios', requireAuth, requireGlobalAdmin, async (req, res) => {
	const { email, password, role, store_slug } = req.body;
	try {
		await pool.query(
			`INSERT INTO users (email, password, role, store_slug)
			 VALUES ($1, $2, $3, $4)
			 ON CONFLICT (email) DO UPDATE 
			 SET password = EXCLUDED.password, role = EXCLUDED.role, store_slug = EXCLUDED.store_slug`,
			[email.trim(), password, role, store_slug || null]
		);
		res.redirect('/admin/lojas');
	} catch (e) {
		console.error(e);
		res.status(500).send('Erro ao cadastrar subadmin.');
	}
});

app.post('/admin/usuarios/excluir/:id', requireAuth, requireGlobalAdmin, async (req, res) => {
	try {
		await pool.query('DELETE FROM users WHERE id = $1', [req.params.id]);
		res.redirect('/admin/lojas');
	} catch (e) {
		console.error(e);
		res.status(500).send('Erro ao excluir subadmin.');
	}
});

// Admin - Dashboard de Produtos
app.get('/admin/produtos', requireAuth, async (req, res) => {
	const allProducts = await getAllProducts();
	res.render('admin_products', { products: allProducts });
});

// Admin - Gerenciamento de Categorias
app.get('/admin/categorias', requireAuth, async (req, res) => {
	try {
		const categories = await getAllCategories();
		res.render('admin_categories', { categories });
	} catch (e) {
		console.error(e);
		res.status(500).send('Erro ao carregar categorias.');
	}
});

app.post('/admin/categorias', requireAuth, async (req, res) => {
	const { name } = req.body;
	if (!name || !name.trim()) {
		return res.status(400).send('Nome da categoria é obrigatório.');
	}
	try {
		await pool.query(
			`INSERT INTO categories (name) VALUES ($1) ON CONFLICT (name) DO NOTHING`,
			[name.trim()]
		);
		res.redirect('/admin/categorias?success=1');
	} catch (e) {
		console.error(e);
		res.status(500).send('Erro ao cadastrar categoria.');
	}
});
app.post('/admin/categorias/excluir/:id', requireAuth, async (req, res) => {
	try {
		await pool.query('DELETE FROM categories WHERE id = $1', [req.params.id]);
		res.redirect('/admin/categorias?success=2');
	} catch (e) {
		console.error(e);
		res.status(500).send('Erro ao excluir categoria.');
	}
});

// Admin - Configurações da Loja e do Banner
app.get('/admin/configuracao', requireAuth, async (req, res) => {
	try {
		const { rows } = await pool.query('SELECT * FROM stores WHERE slug = $1', [req.store.slug]);
		const store = rows[0];
		const products = await getAllProducts();
		res.render('admin_config', { store, products, userRole: req.session.userRole });
	} catch (e) {
		console.error(e);
		res.status(500).send('Erro ao carregar configurações.');
	}
});

app.post('/admin/configuracao', requireAuth, upload.single('bannerImageFile'), async (req, res) => {
	const {
		name, logoUrl, resendApiKey, resendFrom, mpAccessToken,
		bannerProductId, bannerTitle, bannerSubtitle, bannerTimerHours, bannerBackgroundImage
	} = req.body;

	let bgImagePath = bannerBackgroundImage || '';
	if (req.file) {
		bgImagePath = '/images/produtos/' + req.file.filename;
	}

	try {
		await pool.query(
			`UPDATE stores SET
				name = $1,
				logo_url = $2,
				resend_api_key = $3,
				resend_from = $4,
				mp_access_token = $5,
				banner_product_id = $6,
				banner_background_image = $7,
				banner_title = $8,
				banner_subtitle = $9,
				banner_timer_hours = $10
			 WHERE slug = $11`,
			[
				name || '',
				logoUrl || null,
				resendApiKey || null,
				resendFrom || null,
				mpAccessToken || '',
				bannerProductId || null,
				bgImagePath || null,
				bannerTitle || null,
				bannerSubtitle || null,
				bannerTimerHours ? parseInt(bannerTimerHours) : 8,
				req.store.slug
			]
		);
		res.redirect('/admin/configuracao?success=1');
	} catch (e) {
		console.error(e);
		res.status(500).send('Erro ao salvar configurações.');
	}
});

// Admin - Cadastro de Produtos
app.get('/admin/produtos/novo', requireAuth, async (req, res) => {
	const nextId = await getNextProductId();
	const allProducts = await getAllProducts();
	const categories = await getAllCategories();
	res.render('admin_product_create', { products: allProducts, nextId, categories });
});

app.post('/admin/produtos', requireAuth, upload.fields([{ name: 'thumbImages', maxCount: 10 }]), async (req, res) => {
	const {
		id, name, price, priceBefore, priceUpsell, urlProduto, tutorialVideo, moreInfo,
		development, nameSoft, version, licence, formart, description,
		orderbump, upsell, emailMessage, categoryId, systemType
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
	parsedQuestions = parsedQuestions.filter(q => q && typeof q === 'object' && q.question);

	let parsedPinions = [];
	if (req.body.pinions && Array.isArray(req.body.pinions)) {
		parsedPinions = req.body.pinions;
	} else if (req.body.pinions && typeof req.body.pinions === 'object') {
		parsedPinions = Object.values(req.body.pinions);
	}
	parsedPinions = parsedPinions.filter(p => p && typeof p === 'object' && p.pinion);

	const catId = categoryId ? parseInt(categoryId) : null;
	const sysType = systemType || null;

	try {
		await pool.query(
			`INSERT INTO products (
				id, name, price_before, price, price_upsell, url_produto, tutorial_video, more_info,
				image, thumbs, development, name_soft, version, licence, formart, description,
				orderbump, upsell, relation_products, pinions, questions, active, email_message,
				category_id, system_type
			) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25)`,
			[
				id || `PROD${Date.now()}`,
				name || '',
				Number(priceBefore) || 0,
				Number(price) || 0,
				priceUpsell ? Number(priceUpsell) : null,
				urlProduto || '',
				tutorialVideo || '',
				moreInfo || '',
				imagePath || '',
				JSON.stringify(thumbPaths),
				development || '',
				nameSoft || '',
				version || '',
				licence || '',
				formart || '',
				description || '',
				orderbump || '',
				upsell || '',
				JSON.stringify([]),
				JSON.stringify(parsedPinions),
				JSON.stringify(parsedQuestions),
				true,
				emailMessage || '',
				catId,
				sysType
			]
		);
		res.redirect('/admin/produtos/novo?success=1');
	} catch (e) {
		console.error(e);
		res.status(500).send('Erro ao salvar produto no banco de dados.');
	}
});

// Admin - Edição de Produtos
app.get('/admin/produtos/editar/:id', requireAuth, async (req, res) => {
	const product = await getProductById(req.params.id);
	if (!product) return res.status(404).send('Produto não encontrado');
	const allProducts = await getAllProducts();
	const categories = await getAllCategories();
	res.render('admin_product_edit', { product, products: allProducts, categories });
});

app.post('/admin/produtos/editar/:id', requireAuth, upload.fields([{ name: 'thumbImages', maxCount: 10 }]), async (req, res) => {
	const {
		name, price, priceBefore, priceUpsell, urlProduto, tutorialVideo, moreInfo,
		development, nameSoft, version, licence, formart, description,
		orderbump, upsell, emailMessage, categoryId, systemType
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
	parsedQuestions = parsedQuestions.filter(q => q && typeof q === 'object' && q.question);

	let parsedPinions = [];
	if (req.body.pinions && Array.isArray(req.body.pinions)) {
		parsedPinions = req.body.pinions;
	} else if (req.body.pinions && typeof req.body.pinions === 'object') {
		parsedPinions = Object.values(req.body.pinions);
	}
	parsedPinions = parsedPinions.filter(p => p && typeof p === 'object' && p.pinion);

	const catId = categoryId ? parseInt(categoryId) : null;
	const sysType = systemType || null;

	try {
		await pool.query(
			`UPDATE products SET
				name = $1, price_before = $2, price = $3, price_upsell = $4, url_produto = $5,
				tutorial_video = $6, more_info = $7, image = $8, thumbs = $9, development = $10,
				name_soft = $11, version = $12, licence = $13, formart = $14, description = $15,
				orderbump = $16, upsell = $17, pinions = $18, questions = $19, email_message = $20,
				category_id = $21, system_type = $22
			 WHERE id = $23`,
			[
				name || '',
				Number(priceBefore) || 0,
				Number(price) || 0,
				priceUpsell ? Number(priceUpsell) : null,
				urlProduto || '',
				tutorialVideo || '',
				moreInfo || '',
				imagePath || '',
				JSON.stringify(thumbPaths),
				development || '',
				nameSoft || '',
				version || '',
				licence || '',
				formart || '',
				description || '',
				orderbump || '',
				upsell || '',
				JSON.stringify(parsedPinions),
				JSON.stringify(parsedQuestions),
				emailMessage || '',
				catId,
				sysType,
				req.params.id
			]
		);
		res.redirect('/admin/produtos?success=2');
	} catch (e) {
		console.error(e);
		res.status(500).send('Erro ao editar produto no banco de dados.');
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
app.post('/admin/produtos/status/:id', requireAuth, async (req, res) => {
	try {
		await pool.query('UPDATE products SET active = NOT active WHERE id = $1', [req.params.id]);
		res.redirect('/admin/produtos');
	} catch (e) {
		console.error(e);
		res.status(500).send('Erro ao alterar status');
	}
});

// Admin - Excluir Produto
app.post('/admin/produtos/excluir/:id', requireAuth, async (req, res) => {
	try {
		await pool.query('DELETE FROM products WHERE id = $1', [req.params.id]);
		res.redirect('/admin/produtos?success=3');
	} catch (e) {
		console.error(e);
		res.status(500).send('Erro ao excluir produto');
	}
});

// Página de detalhe do produto com formulário de e-mail
app.get('/produto/:id', async (req, res) => {
	try {
		const { id } = req.params;
		const activeProducts = await getActiveProducts();
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
	} catch (err) {
		console.error(err);
		res.status(500).send('Erro ao carregar detalhes do produto');
	}
});

// Comprar produto e renderizar checkout
app.post('/buy/:id', async (req, res) => {
	try {
		const { id } = req.params;
		const email = (req.body && req.body.email) ? String(req.body.email).trim() : '';
		const whatsapp = (req.body && req.body.whatsapp) ? String(req.body.whatsapp).trim() : '';
		const orderbumpId = (req.body && req.body.orderbumpId) ? String(req.body.orderbumpId) : null;

		const activeProducts = await getActiveProducts();
		const product = activeProducts.find(p => p.id === id);
		if (!product) return res.status(404).send('Produto não encontrado');
		if (!email) return res.status(400).send('E-mail é obrigatório');

		let amount = product.price;
		let description = product.name;

		if (orderbumpId) {
			const bumpProduct = activeProducts.find(p => p.id === orderbumpId);
			if (bumpProduct) {
				amount += bumpProduct.price;
				description += ' + ' + bumpProduct.name;
			}
		}

		// Redireciona para o checkout unificado (Pix e Cartão)
		const accessToken = generateAccessToken();
		const finalTarget = `/funil/${accessToken}`;
		await pool.query(
			`INSERT INTO payments (amount, description, target_url, access_token, status, email, product_url, whatsapp, product_name, store_slug)
			 VALUES ($1, $2, $3, $4, 'pending', $5, $6, $7, $8, $9)`,
			[Math.round(amount * 100), description, finalTarget, accessToken, email || null, product.urlProduto || null, whatsapp || null, (product.nameSoft || product.name) || null, req.store.slug]
		);
		return res.redirect(`/checkout/${accessToken}`);
	} catch (err) {
		console.error('Erro /buy:', err);
		return res.status(500).send(`Erro ao iniciar compra: ${err.message || err}`);
	}
});

// GET /checkout/:token - Renderiza tela de pagamento
app.get('/checkout/:token', async (req, res) => {
	try {
		const { token } = req.params;
		const { rows } = await pool.query(
			`SELECT * FROM payments WHERE access_token = $1`,
			[token]
		);
		const row = rows[0];
		if (!row) return res.status(404).send('Token de checkout inválido');

		const activeProducts = await getActiveProducts();
		const product = activeProducts.find(p => p.nameSoft === row.product_name || p.name === row.product_name);
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

// POST /checkout/pix/:token - Cria o pagamento Pix no Mercado Pago via AJAX
app.post('/checkout/pix/:token', async (req, res) => {
	try {
		const { token } = req.params;
		const { rows } = await pool.query(
			`SELECT * FROM payments WHERE access_token = $1`,
			[token]
		);
		const row = rows[0];
		if (!row) return res.status(404).json({ error: 'Checkout não encontrado' });

		const amount = row.amount / 100;

		// Cria o Pix no Mercado Pago
		const transactionAmount = Number(amount.toFixed(2));
		const idempotency = crypto.randomUUID();

		const payerPayload = {
			email: row.email,
			first_name: row.email.split('@')[0] || 'Cliente',
			last_name: 'ComprasLivre',
			identification: {
				type: 'CPF',
				number: req.body.cpf ? req.body.cpf.replace(/\D/g, '') : '19119119100'
			}
		};

		const requestBody = {
			transaction_amount: transactionAmount,
			payment_method_id: 'pix',
			description: row.description || 'PIX ComprasLivre',
			payer: payerPayload
		};

		if (process.env.BASE_URL_PUBLICA) {
			requestBody.notification_url = `${process.env.BASE_URL_PUBLICA.replace(/\/$/, '')}/webhook/mercadopago`;
		}

		console.log('Criando pagamento PIX no checkout (Mercado Pago)...', { description: requestBody.description, amount: transactionAmount });
		const paymentClient = getPaymentInstance(req.store.mp_access_token);
		const createResp = await paymentClient.create({ body: requestBody }, { idempotencyKey: idempotency });

		const mp = createResp || {};
		const paymentId = mp.id || (mp.body && mp.body.id);
		const pix = (mp.point_of_interaction && mp.point_of_interaction.transaction_data) ||
			(mp.body && mp.body.point_of_interaction && mp.body.point_of_interaction.transaction_data) || {};
		const qrCode = pix.qr_code;
		const qrCodeBase64 = pix.qr_code_base64;

		if (!paymentId || !qrCode) {
			throw new Error('Falha ao gerar PIX no Mercado Pago.');
		}

		// Atualiza o banco de dados local
		await pool.query(
			`UPDATE payments SET payment_id = $1, payment_method = 'pix' WHERE access_token = $2`,
			[paymentId.toString(), token]
		);

		return res.json({
			success: true,
			payment_id: paymentId,
			qr_code: qrCode,
			qr_code_base64: qrCodeBase64,
			status: 'pending',
			acesso_url: `/acesso/${token}`,
			status_url: `/status/${paymentId}`
		});
	} catch (err) {
		console.error('Erro ao gerar Pix no checkout:', err.message || err);
		return res.status(500).json({ error: err.message || 'Erro ao gerar Pix' });
	}
});

// POST /checkout/card/:token - Cria pagamento de Cartão de Crédito no Mercado Pago via AJAX
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

		const amount = row.amount / 100;

		// 1. Tokeniza o cartão no Mercado Pago
		const expirationYear = cardYear.length === 2 ? '20' + cardYear : cardYear;

		console.log('[Mercado Pago] Tokenizando cartão...');
		const cardTokenResponse = await fetch('https://api.mercadopago.com/v1/card_tokens', {
			method: 'POST',
			headers: {
				'Authorization': `Bearer ${req.store.mp_access_token}`,
				'Content-Type': 'application/json'
			},
			body: JSON.stringify({
				card_number: cardNumber.replace(/\s/g, ''),
				expiration_month: parseInt(cardMonth),
				expiration_year: parseInt(expirationYear),
				security_code: cardCvv,
				cardholder: {
					name: cardName,
					identification: {
						type: 'CPF',
						number: cpf.replace(/\D/g, '')
					}
				}
			})
		});

		const cardTokenData = await cardTokenResponse.json();
		if (!cardTokenResponse.ok || !cardTokenData.id) {
			console.error('Erro ao tokenizar cartão:', cardTokenData);
			const errorMsg = (cardTokenData && cardTokenData.message) || 'Erro ao validar cartão no Mercado Pago';
			throw new Error(errorMsg);
		}

		const cardTokenId = cardTokenData.id;
		const cardBrand = getCardBrand(cardNumber);

		// 2. Cria o pagamento no Mercado Pago
		const transactionAmount = Number(amount.toFixed(2));
		const idempotency = crypto.randomUUID();

		const requestBody = {
			transaction_amount: transactionAmount,
			token: cardTokenId,
			description: row.description || 'Cartão ComprasLivre',
			installments: parseInt(installments),
			payment_method_id: cardBrand,
			payer: {
				email: row.email,
				identification: {
					type: 'CPF',
					number: cpf.replace(/\D/g, '')
				}
			}
		};

		if (process.env.BASE_URL_PUBLICA) {
			requestBody.notification_url = `${process.env.BASE_URL_PUBLICA.replace(/\/$/, '')}/webhook/mercadopago`;
		}

		console.log('Criando pagamento no cartão (Mercado Pago)...', { description: requestBody.description, amount: transactionAmount, cardBrand });
		const paymentClient = getPaymentInstance(req.store.mp_access_token);
		const createResp = await paymentClient.create({ body: requestBody }, { idempotencyKey: idempotency });

		const mp = createResp || {};
		const paymentId = mp.id || (mp.body && mp.body.id);
		const status = mp.status || (mp.body && mp.body.status);

		if (!paymentId) {
			throw new Error('Falha ao processar pagamento com cartão no Mercado Pago.');
		}

		// Atualiza banco de dados local
		await pool.query(
			`UPDATE payments SET payment_id = $1, payment_method = 'credit_card' WHERE access_token = $2`,
			[paymentId.toString(), token]
		);

		// Se o status retornado for aprovado/autorizado, marca como pago imediatamente e finaliza
		if (status === 'approved' || status === 'authorized') {
			await handlePaymentApproved(paymentId.toString());
			return res.json({
				success: true,
				status: 'paid',
				acesso_url: `/acesso/${token}`
			});
		} else if (status === 'in_process') {
			return res.json({
				success: false,
				status: 'pending',
				message: 'O pagamento está em análise pelo Mercado Pago. Assim que for aprovado, seu acesso será liberado.'
			});
		} else {
			return res.json({
				success: false,
				status: status || 'rejected',
				message: 'O pagamento foi recusado. Por favor, verifique os dados do cartão ou tente outro cartão.'
			});
		}
	} catch (err) {
		console.error('Erro ao processar cartão no checkout:', err.message || err);
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
		const activeProducts = await getActiveProducts();
		const product = activeProducts.find(p => p.nameSoft === row.product_name || p.name === row.product_name);

		if (product && product.upsell) {
			const upsellProduct = activeProducts.find(p => p.id === product.upsell);
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
app.get('/tutorial/:id', async (req, res) => {
	try {
		const { id } = req.params;
		const activeProducts = await getActiveProducts();
		const product = activeProducts.find(p => p.id === id);

		if (!product) return res.status(404).send('Produto ou tutorial não encontrado');

		return res.render('tutorial', { product, products: activeProducts });
	} catch (err) {
		return res.status(500).send('Erro ao carregar tutorial.');
	}
});

// POST /checkout - cria pagamento PIX externo/manual
app.post('/checkout', async (req, res) => {
	try {
		const { amount, description = 'PIX', targetUrl, payer } = req.body || {};
		if (!amount || !targetUrl) {
			return res.status(400).json({ error: 'amount e targetUrl são obrigatórios.' });
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

		const paymentClient = getPaymentInstance(req.store.mp_access_token);
		const createResp = await paymentClient.create({ body: requestBody }, { idempotencyKey: idempotency });

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
			`INSERT INTO payments (payment_id, amount, description, target_url, access_token, status, store_slug)
			 VALUES ($1, $2, $3, $4, $5, 'pending', $6)`,
			[paymentId.toString(), Math.round(transactionAmount * 100), description, targetUrl, accessToken, req.store.slug]
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
		const body = req.body || {};
		const topic = body.topic || body.type;
		let id = body.data && body.data.id ? body.data.id : body.id;

		// Caso venha via querystring (?type=payment&id=123)
		if (!id && req.query && (req.query.id || req.query['data.id'])) {
			id = req.query.id || req.query['data.id'];
		}

		if ((topic === 'payment' || topic === 'payments') && id) {
			const { rows: paymentRows } = await pool.query('SELECT store_slug FROM payments WHERE payment_id = $1', [id.toString()]);
			let token = process.env.MP_ACCESS_TOKEN;
			if (paymentRows.length > 0 && paymentRows[0].store_slug) {
				const { rows: storeRows } = await pool.query('SELECT mp_access_token FROM stores WHERE slug = $1', [paymentRows[0].store_slug]);
				if (storeRows.length > 0) {
					token = storeRows[0].mp_access_token;
				}
			}
			const paymentClient = getPaymentInstance(token);
			const details = await paymentClient.get({ id: id.toString() });
			const status = (details && details.status) || (details.body && details.body.status);

			if (status === 'approved') {
				await handlePaymentApproved(id.toString());
			}
		}

		// Responder 200 rapidamente evita reentregas excessivas
		return res.status(200).json({ received: true });
	} catch (err) {
		console.error('Erro webhook:', err);
		// Mesmo em erro, responda 200 para evitar loop
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