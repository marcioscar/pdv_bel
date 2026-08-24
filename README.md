# PDV BrasSaco

Frente de caixa operada pelo teclado, para a BrasSaco Embalagens.

Três telas, todas navegáveis sem mouse:

- **Caixa** (`/`) — lança produtos, aplica desconto, escolhe a forma de pagamento e fecha a venda.
- **Usuários** (`/usuarios`) — cadastro e desativação de operadores.
- **Estoque** (`/estoque`) — entrada de mercadoria e inventário, com o livro de movimentos.
- **Vendas** (`/vendas`) — histórico, cancelamento com estorno, e o boleto de cada venda a prazo.

## Como funciona o caixa

A barra de comando é o **único ponto de foco** da tela e muda de papel conforme o
modo (busca, quantidade, desconto, valor recebido, vencimento). O operador nunca
precisa procurar onde digitar.

| Digitar | Resultado |
| --- | --- |
| `141` | adiciona 1 unidade do código 141 |
| `3*141` | adiciona 3 unidades |
| `3*papel` | busca "papel" e adiciona 3 do escolhido |

Com a busca vazia, `↑` `↓` movem o item ativo e `+` `−` ajustam a quantidade.
`F1` abre a lista completa de atalhos.

Atalhos com modificador casam por `event.code`, não por `event.key`: no macOS o
Option compõe caracteres. Navegação e formas de pagamento usam teclas de função
(`Ctrl+F1..F3`, `Shift+F1..F5`) porque `Ctrl+C`/`Ctrl+V` são copiar e colar e
`Ctrl+1..4` é reservado pelo navegador.

## Decisões que moldam o código

- **Os totais são recalculados no servidor** a partir dos preços do banco. O
  cliente só informa o que e quanto; total adulterado no navegador não é gravado.
- **O estoque é derivado**, nunca guardado: o saldo é a soma dos movimentos, o que
  torna drift impossível. Entrada soma, inventário grava a diferença, e o
  cancelamento de venda grava o movimento oposto — nada é apagado ou reescrito.
- **A venda a prazo exige cliente com endereço**, porque o boleto exige o pagador.
  O cadastro preenche o endereço pelo CEP.
- **A venda em Pix imediato só nasce depois do pagamento confirmado** — não faz
  sentido baixar estoque de algo que talvez não seja pago. (Fluxo ainda não ligado
  ao caixa; ver Pendências.)
- **Duas coisas travam a venda e pedem o gerente**: desconto acima de 5% do
  subtotal, em qualquer forma de pagamento; e cliente com boleto vencido há mais
  de 3 dias, mas **só na venda a prazo** — quem paga à vista não recebe crédito
  novo, e recusar essa venda não protege nada. A trava é cobrada em
  `registrarVenda`, e no Pix antes de gerar o QR: cobrá-la depois deixaria o
  cliente pagando uma venda que seria recusada em seguida.
- **A liberação do gerente é um registro, não um clique**: guarda o carrinho (o
  vendedor larga a venda e atende o próximo), o retrato da dívida com que ele
  decidiu, e se foi decidida pelo app ou com a senha no próprio caixa. Vale 12
  horas, para uma venda só, e é consumida na mesma transação que grava a venda.

## Comandos

```bash
npm run dev        # desenvolvimento com HMR
npm run build      # build de produção
npm run start      # serve o build
npm run typecheck  # a única verificação disponível
```

## Variáveis de ambiente

```
SESSION_SECRET         # assina o cookie de sessão; obrigatório em produção
DATABASE_URL           # MongoDB (replica set — o Prisma exige para transações)
INTER_BASE_URL         # https://cdpj-sandbox.partners.uatinter.co ou o de produção
INTER_CLIENT_ID
INTER_CLIENT_SECRET
INTER_CHAVE_PIX        # chave DICT, para as cobranças imediatas
INTER_CONTA_CORRENTE   # só se a integração tiver mais de uma conta
INTER_CERT             # certificado em base64 (ou INTER_CERT_PATH em dev)
INTER_KEY              # chave privada em base64 (ou INTER_KEY_PATH em dev)

APP_URL                # endereço público, p/ os links que saem daqui (ex.: avisos)
TELEGRAM_BOT_TOKEN     # bot criado no @BotFather; sem ele o aviso só não sai
TELEGRAM_CHAT_ID       # o grupo dos gerentes (negativo em grupo: -100…)
```

Sem `TELEGRAM_*` o sistema roda igual — o pedido de autorização entra na fila do
mesmo jeito, só não apita no celular de ninguém. `GET /saude` diz em
`avisoTelegram` se está configurado e para qual chat.

O certificado entra por variável de propósito: chave privada não pertence a uma
layer de imagem Docker, então `certificados/` está no `.dockerignore`.

`GET /saude` diz qual build está no ar, se o banco responde e contra qual
ambiente do Inter a aplicação aponta.

## Impressão sem diálogo no caixa

Cupom, comprovante de Pix, boleto e romaneio são impressos pelo navegador. Por
padrão o Chrome abre a caixa de impressão a cada documento — inaceitável no
balcão, onde saem dois papéis por venda em Pix.

`--kiosk-printing` faz o Chrome imprimir direto na **impressora padrão do
sistema**, sem perguntar nada. Duas condições que costumam ser esquecidas: a
impressora padrão do Windows precisa ser a térmica, e **todas** as janelas do
Chrome precisam estar fechadas antes de abrir com a flag — com uma instância já
rodando, o Chrome só abre outra aba no processo existente e a flag é ignorada.

**Windows** — atalho na área de trabalho, botão direito → Propriedades → Destino:

```
"C:\Program Files\Google\Chrome\Application\chrome.exe" --kiosk-printing --user-data-dir="C:\pdv-chrome" --app=https://pdv.brassaco.com
```

**macOS**:

```bash
open -na "Google Chrome" --args --kiosk-printing \
  --user-data-dir="$HOME/.pdv-chrome" --app=https://pdv.brassaco.com
```

**Linux**:

```bash
google-chrome --kiosk-printing --user-data-dir=~/.pdv-chrome \
  --app=https://pdv.brassaco.com &
```

As outras duas opções não são enfeite. `--user-data-dir` cria um perfil só do
caixa: separa a sessão do PDV do Chrome pessoal de quem usa o computador e
garante que a flag valha, já que é outra instância. `--app` abre sem barra de
endereço nem abas — o operador não navega para lugar nenhum, e ninguém fecha o
sistema sem querer clicando na aba errada.

Para conferir se pegou: abra `chrome://version` e procure `--kiosk-printing` na
linha de comando. Se não estiver lá, sobrou uma janela aberta antes.

O tamanho do papel (80mm) e as margens vêm do driver da impressora, não do
navegador: configure na impressora térmica em Dispositivos e Impressoras.

## Integração com o Banco Inter

- Autenticação **mTLS** via dispatcher do undici — o `fetch` do Node não aceita
  certificado de cliente por opção de request.
- O token é pedido **uma vez para todos os escopos**: o endpoint aceita 5 chamadas
  por minuto, e pedir um token por combinação estourava o limite.
- Venda a prazo emite o "bolepix" (boleto com QR Pix embutido). A emissão é
  **assíncrona**: a resposta traz só o `codigoSolicitacao`, e a linha digitável
  chega na consulta ou pelo callback. O PDF vem em base64, não como binário.
- Webhook de cobrança em `/webhooks/inter/cobranca`, idempotente e respondendo
  200 até a corpo inválido — erro faria o Inter reenviar por horas.
- **Não existe webhook de Pix.** O Inter aceita um destino por chave Pix, e a
  chave desta conta é usada por outro sistema da empresa; registrar aqui desviaria
  as notificações de pagamento dele. O PDV confirma Pix consultando
  `GET /pix/v2/cob/{txid}`, que é o certo para o balcão de qualquer forma.
  `registrarWebhookCobranca` consulta o destino atual e recusa sobrescrever URL
  de terceiro sem `{ sobrescrever: true }`.

## Pendências

- **Pix imediato no balcão**: criar e consultar a cobrança funcionam e estão
  testados, mas a transição para `CONCLUIDA` nunca foi observada (os simuladores
  do sandbox do Inter estavam indisponíveis). O fluxo não foi ligado ao caixa
  porque liberaria mercadoria sobre uma confirmação não verificada. A confirmação
  será por consulta, não por webhook — ver acima.
- `CAIXA` e `OPERADOR` são constantes; viram sessão quando houver login.
- Papéis de usuário: hoje todo operador pode tudo, inclusive cancelar venda e
  cadastrar outros usuários.
