## PIX MVP - Node.js + Express + PostgreSQL + Mercado Pago

Aplicação mínima para gerar cobranças PIX, receber webhook de confirmação e liberar acesso a conteúdo com credenciais. Front-end em EJS com:
- Lista de produtos
- Página de produto com formulário de e-mail e geração de PIX
- Checkout com QR e polling de status
- Página de obrigado com senha gerada
- Área de membros (login por e-mail + senha) exibindo o link do produto


### 1) Requisitos
- Node.js 18+
- PostgreSQL 12+
- Conta Mercado Pago (com PIX habilitado para produção) ou usuário de teste (sandbox)
- Opcional (dev): ngrok para expor webhooks


### 2) Instalação
```bash
npm install
# Se ainda não instalou as libs do projeto:
# npm i express mercadopago dotenv ejs pg body-parser
```


### 3) Banco de dados (PostgreSQL)
Crie um banco (ex.: `pixdb`) e um usuário com acesso:

```sql
CREATE DATABASE pixdb;
-- Ajuste o usuário/senha conforme seu ambiente
-- CREATE USER pixuser WITH ENCRYPTED PASSWORD 'sua_senha';
-- GRANT ALL PRIVILEGES ON DATABASE pixdb TO pixuser;
```

Conexão configurada via variáveis de ambiente (ver seção .env). Ao iniciar o app, a tabela `payments` é criada automaticamente se não existir.


### 4) Mercado Pago - credenciais
- Sandbox: crie um usuário de teste (retorna `APP_USR-...`) e use o `access_token` desse usuário no `.env`.
- Produção: use o `access_token` da sua conta aprovada, com PIX habilitado (KYC/compliance ok).

Importante:
- Em produção, envie dados reais do pagador; em muitos casos o CPF não é obrigatório, mas o e-mail precisa ser válido.
- O webhook precisa estar acessível publicamente por HTTPS.


### 5) Variáveis de ambiente (.env)
Crie um arquivo `.env` na raiz:

```ini
# Servidor
PORT=3000
BASE_URL_PUBLICA=https://seu-dominio-ou-ngrok.tld

# Mercado Pago
MP_ACCESS_TOKEN=APP_USR_xxx   # Produção ou usuário de teste
# MP_PAYER_EMAIL=opcional@teste.com

# PostgreSQL (use DATABASE_URL OU os campos individuais)
#DATABASE_URL=postgres://usuario:senha@host:5432/pixdb
PGHOST=localhost
PGPORT=5432
PGUSER=postgres
PGPASSWORD=sua_senha
PGDATABASE=pixdb

# SSL (apenas se necessário em cloud)
# PGSSLMODE=require
```


### 6) Executando
```bash
npm start
# ou
node app.js
```

- Acesse `http://localhost:3000/` para ver a lista de produtos.
- Clique em um produto, informe o e-mail e gere o PIX.
- O checkout mostra QR e chave “copia e cola” e faz polling do status.


### 7) Webhook (obrigatório para aprovar automaticamente)
1. Exponha a aplicação publicamente (durante desenvolvimento):
```bash
ngrok http 3000
```
2. No painel do Mercado Pago, configure o webhook para:
```
POST {BASE_URL_PUBLICA}/webhook/mercadopago
```
3. Quando o pagamento for aprovado, o webhook marca o registro como `paid` e gera a senha (`access_password`). O front redireciona para `/obrigado/:token`.


### 8) Teste em PRODUÇÃO (passo a passo)
1. Garanta que sua conta Mercado Pago esteja aprovada e com PIX habilitado.
2. Ajuste `.env` com o `MP_ACCESS_TOKEN` de produção e `BASE_URL_PUBLICA` do seu domínio HTTPS.
3. Garanta que o banco Postgres de produção está acessível e configure as variáveis (ou `DATABASE_URL`).
4. Faça deploy da aplicação em um servidor/serviço (PM2, Docker, VPS, PaaS etc.).
5. Configure o webhook no painel do Mercado Pago para `POST {BASE_URL_PUBLICA}/webhook/mercadopago`.
6. Abra `{BASE_URL_PUBLICA}/`, selecione um produto e gere um PIX usando um e-mail real. Pague com o app do seu banco.
7. Ao aprovar, você será redirecionado para `/obrigado/:token`; anote a senha.
8. Acesse `{BASE_URL_PUBLICA}/membros`, faça login com e-mail + senha e verifique se o link do produto (`product_url`) aparece.


### 9) Personalizações úteis
- Produtos: editáveis no array `products` em `app.js` (id, name, description, price, urlProduto).
- Views EJS em `views/`:
  - `products.ejs` (lista)
  - `product_detail.ejs` (form e-mail)
  - `checkout.ejs` (QR e status)
  - `obrigado.ejs` (senha)
  - `membros_login.ejs` e `membros_area.ejs`


### 10) Solução de problemas
- 401 Unauthorized (MP): credencial de produção sem conta habilitada para PIX, ou uso incorreto de tokens. Revise `MP_ACCESS_TOKEN` e habilitação PIX.
- Webhook não dispara: verifique se `BASE_URL_PUBLICA` está correto, se o endpoint está público/HTTPS e se a URL foi configurada no painel.
- Pagamento não atualiza para paid: confira logs do servidor e a resposta do `payment.get` no webhook. Pode haver atraso breve do provedor.
- Banco: verifique a conexão do Postgres e se a tabela `payments` existe. O app cria automaticamente no start.


### 11) Fluxo resumido
- `GET /` → lista produtos
- `GET /produto/:id` → página do produto com form de e-mail
- `POST /buy/:id` → cria pagamento PIX e renderiza `checkout`
- `POST /webhook/mercadopago` → recebe eventos; confirma aprovação e gera senha
- `GET /obrigado/:token` → exibe parabéns e credenciais
- `GET/POST /membros` → login e listagem de `product_url`


### 12) Segurança (próximos passos)
- Validar assinatura do webhook (quando disponível) e verificar o `topic/type` adequadamente.
- Rate limiting e logs estruturados.
- Persistir usuários/assinaturas em tabelas próprias se necessário.
- Sessões na área de membros e expiração de senhas temporárias, conforme sua necessidade.


