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
node app.js

# Modo Desenvolvimento
npm run dev
```

## Subindo um novo Projeto a partir desse na VPS e no CloudFlare:

1. Mudar o nome da pasta do projeto para o nome do novo projeto
2. Mudar a porta no docker-compose.yml para uma porta livre (ex: 4302)
3. Subir para a vps através do GIT. para /home/dayvson/app
4. entrar no diretorio do novo projeto:
    > cd novoapp
4.1 criar o .env > nano .env
    e adicionar as variáveis do novo projeto.
4.2 Criar Api de integração com o Mercado Pago para pegar as credenciais de Produção 
    e mudar a URL do Webhook no novo projeto para a URL do novo projeto. 
    Ex: novoapp.seusprogramas.com.br/webhook/mercadopago
4.3 Rodar o comando build do docker:
    > docker compose up -d --build
4.4 rode o 
    > docker ps
    para ver se o container subiu corretamente e se o banco de dados está funcionando.
    Ele precisa mostrar os dois containers rodando corretamente.
    - novoapp-db
    - novoapp-app
4.3 Caso não mostre os dois, rode o comando:
    > docker compose restart app
    
5. Configurar o CloudFlare apontando o domínio para a VPS
5.1 Vai em DNS >> Registros >> Adicionar Novo Registro
    Tipo: A
    Nome: novoapp
    IPv4: IP da sua VPS
6. No arquivo nginx.conf adicionar o novo site:
6.1. No servidor VPS use o comando: 
    > sudo nano /etc/nginx/sites-available/novoapp
6.2. Adicione o seguinte conteúdo:
    server {
    server_name novoapp.seusprogramas.com.br;

    location / {
        proxy_pass http://localhost:4302;
        proxy_http_version 1.1;

        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_cache_bypass $http_upgrade;
    }
}
7. Ativar o site no nginx: 
    > sudo ln -s /etc/nginx/sites-available/novoapp /etc/nginx/sites-enabled/
    > sudo nginx -t
    > sudo systemctl reload nginx
8. Gerar SSL:
    > sudo certbot --nginx
8.1 Escolha a opção referente ao seu subdomínio
9. Pronto o projeto está rodando no servidor VPS e no CloudFlare!


---
© 2026 Compras Livre Tec. Todos os direitos reservados.
