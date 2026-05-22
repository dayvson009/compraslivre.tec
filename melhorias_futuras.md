# Sugestões de Melhorias Futuras - Compras Livre Tec

Este documento reúne análises, sugestões de melhorias arquiteturais, de segurança e de escalabilidade identificadas no projeto para desenvolvimento futuro.

---

## 1. Migração de Catálogo de Produtos (JSON para PostgreSQL)

* **Status Atual:** Os dados de produtos são mantidos no arquivo local `products.json` e carregados em memória na inicialização do servidor. Atualizações no painel administrativo regravam o arquivo por completo usando `fs.writeFileSync`.
* **Problema:** 
  * Não é seguro contra escrita concorrente (dois administradores salvando alterações ao mesmo tempo podem sobrescrever as alterações um do outro).
  * Inviabiliza o dimensionamento horizontal (múltiplas réplicas do container por trás de um load balancer terão dados dessincronizados).
* **Solução Proposta:** Criar uma tabela `products` no banco de dados PostgreSQL e migrar as rotas de listagem, inserção, atualização e deleção para consultas SQL (via `pg` pool).

---

## 2. Validação Fina de Inputs de Checkout

* **Status Atual:** A rota de checkout `/buy/:id` valida apenas a presença de caracteres no campo `email`.
* **Problema:** 
  * O input de e-mails em formato inválido ou números de WhatsApp malformatados passam pelo backend, podendo gerar falhas na entrega da licença ou no envio dos webhooks de conversão (ex: formulário Google Forms).
* **Solução Proposta:** Implementar validações baseadas em expressões regulares (Regex) no backend para garantir:
  * E-mails com formato padrão (ex: `usuario@dominio.com`).
  * Números de telefone (WhatsApp) contendo apenas dígitos numéricos e DDDs válidos do Brasil.

---

## 3. Proteção Contra Força Bruta no Painel Admin

* **Status Atual:** O painel administrativo em `/admin/login` valida o usuário e senha diretamente com variáveis estáticas no arquivo `.env`.
* **Problema:** 
  * Ausência de limites de tentativas consecutivas deixa o painel vulnerável a ataques de dicionário ou varreduras automatizadas.
* **Solução Proposta:** Integrar a biblioteca `express-rate-limit` nas rotas POST do painel de administração para bloquear temporariamente (ex: por 15 minutos) endereços IP que excederem o limite de tentativas de login inválidas.

---

## 4. Ocultação de Erros de APIs Externas

* **Status Atual:** Ao falhar a criação de um pagamento nos gateways parceiros (Mercado Pago ou AppMax), o backend repassa a mensagem crua de erro recebida da API externa diretamente para a tela do usuário.
* **Problema:** 
  * Exposição de dados técnicos internos ou mensagens de validação confusas para o cliente final.
* **Solução Proposta:** Tratar os retornos de erro das APIs de forma que logs detalhados e técnicos fiquem salvos apenas localmente no console/servidor, enquanto uma mensagem amigável e simplificada seja apresentada ao usuário na interface de checkout.

---

## 5. Endurecimento das Sessões do Express

* **Status Atual:** O middleware `express-session` utiliza uma senha secreta padrão de fallback se `SESSION_SECRET` não estiver presente nas variáveis de ambiente. Os cookies também são configurados sem restrições de protocolo HTTPS.
* **Problema:** 
  * Utilização de segredos estáticos padrões aumenta o risco de decodificação e falsificação de cookies de sessão.
* **Solução Proposta:**
  * Lançar um erro ou aviso impeditivo na inicialização se `process.env.SESSION_SECRET` estiver vazio.
  * Habilitar o atributo `secure: true` nos cookies de sessão em ambiente de produção (rodando sob HTTPS).
