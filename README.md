# ComprasLivre.tec - Funil de Vendas & Entrega Digital

Este projeto é uma infraestrutura completa de vendas e automação de entrega para produtos digitais, utilizando Node.js, Express, PostgreSQL e integração com Mercado Pago (PIX).

## 🚀 Funcionalidades Principais
- **Funil de Vendas de Alta Performance**: Fluxo otimizado de Produto -> Checkout -> Upsell -> Tutorial.
- **Pagamento via PIX**: Integração nativa com Mercado Pago para geração e confirmação instantânea.
- **Automação de Entrega**: Envio automático de dados para o Google Forms após a confirmação do pagamento.
- **Order Bump & Upsell**: Estratégias de escalabilidade integradas no checkout e pós-venda.
- **Painel Administrativo**: Gestão completa de produtos, preços, depoimentos (pinions) e FAQs via interface protegida.
- **Sistema de Polling & Webhook**: Verificação dupla para garantir que nenhum pagamento aprovado seja perdido.

## 🛠️ Requisitos
- **Node.js**: Versão 18 ou superior.
- **PostgreSQL**: Banco de dados relacional.
- **Mercado Pago**: Token de acesso (Produção ou Sandbox).

## 📦 Instalação
1. Clone o repositório.
2. Instale as dependências:
```bash
npm install
```

## ⚙️ Configuração (Arquivo .env)
Crie um arquivo `.env` na raiz do projeto com as seguintes variáveis:

```ini
# Servidor
PORT=3000
BASE_URL_PUBLICA=https://seu-dominio.com
SESSION_SECRET=uma_chave_aleatoria_e_segura

# Mercado Pago
MP_ACCESS_TOKEN=APP_USR-seu-token-aqui
MP_REQUIRE_CPF=false # true se quiser exigir CPF no checkout

# Admin (Acesso ao Painel)
ADMIN_LOGIN=admin@compraslivre.com
ADMIN_PASS=SuaSenhaForteAqui

# Banco de Dados PostgreSQL
PGHOST=localhost
PGPORT=5432
PGUSER=seu_usuario
PGPASSWORD=sua_senha
PGDATABASE=compraslivre
# Ou use a URL completa:
# DATABASE_URL=postgres://usuario:senha@host:5432/banco

# Automação (Poller)
POLLER_ENABLED=true
POLLER_INTERVAL_MS=15000
```

## 🗄️ Banco de Dados
O sistema inicializa o esquema automaticamente ao iniciar, mas caso precise criar a tabela manualmente, use o seguinte SQL:

```sql
CREATE TABLE payments (
    id SERIAL PRIMARY KEY,
    payment_id TEXT UNIQUE,
    amount INTEGER NOT NULL,
    description TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    target_url TEXT NOT NULL,
    access_token TEXT UNIQUE NOT NULL,
    email TEXT,
    whatsapp TEXT,
    product_name TEXT,
    access_password TEXT,
    product_url TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    paid_at TIMESTAMP
);

CREATE INDEX idx_payments_status_created ON payments (status, created_at DESC);
```

## 🖥️ Painel Administrativo
O painel administrativo pode ser acessado via `/admin/login`.
- **Dashboard**: Visualize todos os produtos cadastrados.
- **Novo Produto**: Cadastre softwares com descrição rica (HTML), miniaturas, FAQs e depoimentos.
- **Upsell/Orderbump**: Configure estrategicamente qual produto será oferecido como complemento em cada venda.
- **Preço Upsell**: Defina preços promocionais exclusivos para produtos quando oferecidos no funil de pós-venda.

## 📦 Estrutura de Produtos
Os produtos são armazenados e gerenciados dinamicamente no arquivo `products.json`. O sistema lê este arquivo em tempo real, permitindo atualizações sem necessidade de reiniciar o servidor.

## 🌐 Webhook (Mercado Pago)
Para aprovação automática, configure a URL de notificação no painel do Mercado Pago:
`POST https://seu-dominio.com/webhook/mercadopago`

## 🚀 Executando
```bash
# Modo Produção
npm start

# Modo Desenvolvimento
npm run dev
```

---
© 2026 Compras Livre Tec. Todos os direitos reservados.
