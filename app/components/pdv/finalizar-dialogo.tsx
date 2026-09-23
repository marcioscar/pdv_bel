import { useEffect, useMemo, useRef, useState } from "react";
import {
  Banknote,
  CalendarClock,
  CreditCard,
  FileText,
  IdCard,
  Link2,
  Printer,
  QrCode,
  Search,
  Truck,
  User,
  UserPlus,
  Wallet,
} from "lucide-react";

import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Kbd } from "~/components/ui/kbd";
import { Separator } from "~/components/ui/separator";
import { formatarCpfCnpj, mascararCpfCnpj, validarCpf } from "~/lib/documento";
import { modeloDaVenda } from "~/lib/fiscal";
import { interpretarValor, moeda } from "~/lib/moeda";
import {
	ehTransferenciaEntreLojas,
	FORMAS_DE_CAIXA,
	FORMAS_PAGAMENTO,
	type FormaPagamento,
} from "~/lib/pdv";
import type { ClienteResumo } from "~/components/pdv/cliente-dialogo";
import { cn } from "~/lib/utils";

const ICONES: Record<
  FormaPagamento,
  React.ComponentType<{ className?: string }>
> = {
  dinheiro: Banknote,
  credito: CreditCard,
  debito: Wallet,
  pix: QrCode,
  prazo: CalendarClock,
  link: Link2,
  transferencia: Truck,
};

type Props = {
  total: number;
  volumes: number;
  itens: number;
  forma: FormaPagamento;
  onFormaChange: (forma: FormaPagamento) => void;
  recebido: string;
  onRecebidoChange: (valor: string) => void;
  /** Quanto do saldo do cliente está sendo abatido nesta venda. */
  creditoUsado: number;
  onCreditoUsadoChange: (valor: number) => void;
  /** Código do vendedor digitado pelo caixa — é dele a comissão desta venda. */
  vendedorCodigo: string;
  onVendedorCodigoChange: (codigo: string) => void;
  /** Todos os da loja, para o nome aparecer sem ida à rede a cada tecla. */
  vendedores: { id: string; codigo: string; nome: string }[];
  cliente: ClienteResumo | null;
  /** Lista para escolher aqui dentro, sem abrir outro diálogo por cima. */
  clientes: ClienteResumo[];
  onClienteChange: (cliente: ClienteResumo | null) => void;
  /** Cadastro de cliente novo: exige endereço, então tem tela própria. */
  onCadastrarCliente: () => void;
  imprimir: boolean;
  onImprimirChange: (imprimir: boolean) => void;
  /** Se esta loja emite nota, e se o que sai vale como documento. */
  fiscal: { emite: boolean; producao: boolean };
  emitirNota: boolean;
  onEmitirNotaChange: (emitir: boolean) => void;
  /** CPF que o consumidor pediu na nota, sem virar cadastro (Nota Legal). */
  cpfNaNota: string;
  onCpfNaNotaChange: (cpf: string) => void;
  gravando: boolean;
  erro: string | null;
  onConfirmar: () => void;
  onFechar: () => void;
  /** Enquanto outro diálogo está por cima, este não escuta o teclado. */
  pausado?: boolean;
};

/**
 * Conferência antes de gravar a venda.
 *
 * Abre com **tudo já decidido** — forma, cliente e impressão vêm preenchidos — e
 * o Enter fecha a venda. Isso é o que separa esta tela de um formulário: a venda
 * rápida continua rápida (dinheiro segue em F10 → valor → Enter), e cada item é
 * alterável com uma tecla só para quem precisar.
 *
 * A forma de pagamento mora AQUI, e não também no painel lateral: dois lugares
 * decidindo o mesmo dado é como se grava venda em dinheiro marcada como cartão.
 */
export function FinalizarDialogo({
  total,
  volumes,
  itens,
  forma,
  onFormaChange,
  recebido,
  onRecebidoChange,
  creditoUsado,
  onCreditoUsadoChange,
  vendedorCodigo,
  onVendedorCodigoChange,
  vendedores,
  cliente,
  clientes,
  onClienteChange,
  onCadastrarCliente,
  imprimir,
  onImprimirChange,
  fiscal,
  emitirNota,
  onEmitirNotaChange,
  cpfNaNota,
  onCpfNaNotaChange,
  gravando,
  erro,
  onConfirmar,
  onFechar,
  pausado = false,
}: Props) {
  const campoRecebido = useRef<HTMLInputElement>(null);
  const campoCliente = useRef<HTMLInputElement>(null);
  const campoVendedor = useRef<HTMLInputElement>(null);

  /**
   * A saída para outra loja da rede não se escolhe: decorre do cliente ser uma
   * delas. Aqui a tela só obedece — quem decide, e recusa o contrário, é o
   * servidor, que confere o CNPJ na gravação.
   */
  const paraARede = cliente?.lojaDaRede != null;

  const emDinheiro = forma === "dinheiro";
  const aPrazo = forma === "prazo";

  /**
   * O crédito abate do total e o resto é que se paga.
   *
   * O teto é o menor entre o saldo do cliente e o total da venda: não se abate
   * mais do que ele tem, nem mais do que ele está levando. A transferência
   * entre lojas fica de fora — não há saldo nem o que pagar.
   */
  const saldo = paraARede ? 0 : (cliente?.credito ?? 0);
  const creditoDisponivel = Math.min(saldo, total);
  const credito = Math.min(creditoUsado, creditoDisponivel);
  const aPagar = Math.max(0, total - credito);

  const valorRecebido = interpretarValor(recebido);
  const troco = valorRecebido === null ? null : valorRecebido - aPagar;
  const faltaDinheiro =
    emDinheiro && (valorRecebido === null || troco === null || troco < 0);
  const faltaCliente = aPrazo && cliente === null;

  /**
   * O nome é resolvido aqui na tela, contra a lista que veio pronta, só para o
   * caixa CONFERIR antes do Enter. Quem decide de quem é o código é o servidor,
   * na gravação — aqui é conferência, não autoridade.
   *
   * Sem esse eco, um dedo errado creditaria a comissão a outra pessoa e ninguém
   * descobriria até o fechamento do mês.
   */
  const vendedor =
    vendedores.find((v) => v.codigo === vendedorCodigo.trim()) ?? null;
  // Transferência não gera comissão, então não há vendedor a exigir: pedir um
  // creditaria a alguém uma saída que não é venda de ninguém.
  const faltaVendedor = vendedor === null && !paraARede;

  /**
   * A escolha do cliente acontece AQUI DENTRO, trocando esta seção por uma busca.
   *
   * Antes ela abria outro diálogo por cima deste: dois modais empilhados, o
   * operador perdendo de vista o total que ia cobrar, e duas telas disputando o
   * teclado. Cadastrar cliente novo continua tendo tela própria — exige endereço
   * completo, que o boleto recusa pela metade.
   */
  const [escolhendoCliente, setEscolhendoCliente] = useState(false);
  const campoCpf = useRef<HTMLInputElement>(null);
  const [buscaCliente, setBuscaCliente] = useState("");
  const [indiceCliente, setIndiceCliente] = useState(0);

  const encontrados = useMemo(() => {
    const termo = buscaCliente
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .trim();
    const digitos = buscaCliente.replace(/\D/g, "");
    if (!termo) return clientes.slice(0, 6);

    return clientes
      .filter(
        (c) =>
          [c.nome, c.nomeFantasia ?? ""].some((nome) =>
            nome
              .normalize("NFD")
              .replace(/[\u0300-\u036f]/g, "")
              .toLowerCase()
              .includes(termo),
          ) ||
          (digitos.length >= 3 && c.cpfCnpj.includes(digitos)),
      )
      .slice(0, 6);
  }, [buscaCliente, clientes]);

  // "Consumidor Final" é sempre a primeira opção: é o padrão do balcão, e limpar
  // o cliente precisa ser tão fácil quanto escolher um.
  const opcoes: (ClienteResumo | null)[] = [null, ...encontrados];

  useEffect(() => setIndiceCliente(0), [buscaCliente])

  /**
   * Cliente definido por fora fecha a busca — é o caso do cadastro novo, que
   * acontece em tela própria e volta com o cliente já vinculado. Sem isto o
   * operador voltava para a lista de busca em vez de ver quem acabou de cadastrar.
   */
  const clienteEscolhido = cliente?.id ?? null
  useEffect(() => {
    if (clienteEscolhido) {
      setEscolhendoCliente(false)
      setBuscaCliente("")
    }
  }, [clienteEscolhido]);
  useEffect(() => {
    if (escolhendoCliente) campoCliente.current?.focus();
    else if (emDinheiro && !pausado) campoRecebido.current?.focus();
  }, [escolhendoCliente]);

  // Em dinheiro o cursor já entra no valor recebido: é o único campo que a venda
  // rápida precisa digitar, e chegar nele com o mouse seria um passo a mais.
  useEffect(() => {
    if (emDinheiro && !pausado && !escolhendoCliente)
      campoRecebido.current?.focus();
  }, [emDinheiro, pausado, escolhendoCliente]);

  useEffect(() => {
    if (pausado) return;

    function aoTeclar(evento: KeyboardEvent) {
      const { key, shiftKey, ctrlKey, altKey, metaKey } = evento;
      if (ctrlKey || altKey || metaKey) return;

      // Escolhendo cliente, o teclado é todo dele: digitar filtra, setas andam,
      // Enter escolhe, Esc volta. Sem isto o Enter fecharia a venda no meio da
      // escolha, e o ⇧F1 trocaria a forma sem ninguém ver.
      if (escolhendoCliente) {
        if (key === "Escape") {
          evento.preventDefault();
          setEscolhendoCliente(false);
          return;
        }
        if (key === "ArrowDown" || key === "ArrowUp") {
          evento.preventDefault();
          const delta = key === "ArrowDown" ? 1 : -1;
          setIndiceCliente((atual) =>
            Math.min(Math.max(atual + delta, 0), opcoes.length - 1),
          );
          return;
        }
        if (key === "Enter") {
          evento.preventDefault();
          onClienteChange(opcoes[indiceCliente] ?? null);
          setEscolhendoCliente(false);
          setBuscaCliente("");
          return;
        }
        if (key === "F2") {
          evento.preventDefault();
          onCadastrarCliente();
        }
        return;
      }

      // ⇧F1..F5 escolhem a forma, como no resto do sistema.
      if (shiftKey) {
        const posicao = FORMAS_DE_CAIXA.findIndex((_, i) => key === `F${i + 1}`);
        // Com uma loja da rede vinculada não há forma a escolher: a saída é
        // transferência, e ⇧F muda para uma forma que o servidor vai recusar.
        if (posicao >= 0 && !paraARede) {
          evento.preventDefault();
          onFormaChange(FORMAS_DE_CAIXA[posicao].id);
        }
        return;
      }

      if (key === "Escape") {
        evento.preventDefault();
        onFechar();
        return;
      }
      if (key === "Enter") {
        evento.preventDefault();
        // Enter anda até o que falta antes de fechar: com o vendedor vazio ele
        // leva o cursor para lá em vez de esbarrar num botão desabilitado, e a
        // venda em dinheiro vira "valor, Enter, código, Enter".
        if (faltaVendedor) {
          campoVendedor.current?.focus();
          campoVendedor.current?.select();
          return;
        }
        onConfirmar();
        return;
      }
      if (key === "F8") {
        evento.preventDefault();
        campoVendedor.current?.focus();
        campoVendedor.current?.select();
        return;
      }
      if (key === "F6") {
        evento.preventDefault();
        setBuscaCliente("");
        setEscolhendoCliente(true);
        return;
      }
      if (key === "F2" && !cliente && fiscal.emite) {
        evento.preventDefault();
        campoCpf.current?.focus();
        campoCpf.current?.select();
        return;
      }
      // F7 gira o ciclo do que a venda produz: documento fiscal, cupom, nada.
      if (key === "F7") {
        evento.preventDefault();
        girarSaida();
        return;
      }
    }

    window.addEventListener("keydown", aoTeclar, true);
    return () => window.removeEventListener("keydown", aoTeclar, true);
  }, [
    escolhendoCliente,
    faltaVendedor,
    imprimir,
    indiceCliente,
    onCadastrarCliente,
    onClienteChange,
    onConfirmar,
    onFechar,
    onFormaChange,
    onImprimirChange,
    onEmitirNotaChange,
    emitirNota,
    fiscal.emite,
    cliente,
    opcoes,
    pausado,
  ]);

  /**
   * O que a conferência promete sobre a nota.
   *
   * As três situações são diferentes de verdade: a NFC-e sai sozinha e vira o
   * papel do cliente; a NF-e espera o vendedor informar frete e observação na
   * tela de Vendas; e a loja que ainda não emite continua no cupom não fiscal.
   * Prometer errado aqui é o que faz alguém procurar um documento que não veio.
   */
  // Só a partir de 11 dígitos vale julgar: julgar antes acusaria de inválido
  // todo CPF pela metade, enquanto ainda está sendo digitado.
  const digitosCpf = cpfNaNota.replace(/\D/g, "");
  const cpfInvalido = digitosCpf.length === 11 && !validarCpf(digitosCpf);

  /**
   * O que esta venda produz — em um lugar só.
   *
   * Emitir a nota e imprimir o papel pareciam duas escolhas, e dois cartões
   * acesos liam-se como dois documentos saindo. Nunca saíram dois: com a NFC-e
   * valendo, o papel É o DANFE dela. Então é um ciclo de três: o documento
   * fiscal, o cupom não fiscal, e nada.
   *
   * O modelo continua sem se escolher: NFC-e ou NF-e sai do cliente e da forma
   * de pagamento.
   */
  const modelo = modeloDaVenda({ forma, clienteCpfCnpj: cliente?.cpfCnpj ?? null });
  const nomeDoModelo = modelo === "nfe" ? "NF-e" : "NFC-e";

  const estado: "fiscal" | "cupom" | "nada" = emitirNota
    ? "fiscal"
    : imprimir
      ? "cupom"
      : "nada";

  const saida = (() => {
    if (estado === "fiscal") {
      /*
       * O DANFE da NF-e é A4 e não vai para a bobina; o da NFC-e em homologação
       * não vale como documento. Nos dois casos quem sai é o cupom, e dizer isso
       * evita o vendedor procurar um papel que não veio.
       */
      const papelDaVez =
        modelo === "nfe"
          ? "a nota sai na tela de Vendas"
          : fiscal.producao
            ? null
            : "sai o cupom; a nota é de teste";

      return {
        estado,
        destaque: true,
        rotulo: nomeDoModelo,
        situacao:
          modelo === "nfe" || !fiscal.producao ? "emitir com a venda" : "emitir e imprimir",
        aviso:
          modelo === "nfe" && papelDaVez
            ? `${papelDaVez} · sem frete e sem observação`
            : papelDaVez,
      };
    }

    if (estado === "cupom") {
      return {
        estado,
        destaque: true,
        rotulo: "Papel",
        situacao: "cupom não fiscal",
        aviso: fiscal.emite ? "sem nota fiscal" : null,
      };
    }

    return {
      estado,
      destaque: false,
      rotulo: "Papel",
      situacao: "não imprimir",
      aviso: fiscal.emite ? "sem nota fiscal" : null,
    };
  })();

  /**
   * Gira o ciclo. A loja que ainda não emite pula o primeiro estado: oferecer
   * "emitir" onde a emissão está desligada seria prometer o que não acontece.
   */
  function girarSaida() {
    if (estado === "fiscal") {
      onEmitirNotaChange(false);
      onImprimirChange(true);
      return;
    }
    if (estado === "cupom") {
      onImprimirChange(false);
      return;
    }
    if (fiscal.emite) {
      onEmitirNotaChange(true);
      onImprimirChange(true);
      return;
    }
    onImprimirChange(true);
  }


  /*
   * Vendedor e cliente respondem a mesma pergunta — quem —, então andam lado a
   * lado e poupam uma faixa de altura no diálogo. O do vendedor passou a ter a
   * forma do de cliente (rótulo em cima, resposta embaixo) porque dois cartões
   * com anatomias diferentes na mesma linha leem-se como dois assuntos.
   */
  const cartaoVendedor = (
    <div
      className={cn(
        "flex items-center gap-2 rounded-lg border p-3",
        faltaVendedor ? "border-destructive/50 bg-destructive/5" : "border-border bg-muted/30",
      )}
    >
      <Input
        ref={campoVendedor}
        id="vendedor"
        type="search"
        value={vendedorCodigo}
        onChange={(e) => onVendedorCodigoChange(e.target.value)}
        placeholder="cód"
        inputMode="numeric"
        autoComplete="off"
        aria-label="Código do vendedor"
        data-1p-ignore=""
        data-lpignore="true"
        className="h-9 w-14 shrink-0 rounded-lg px-1 text-center font-mono text-lg tabular-nums"
      />
      <div className="min-w-0 flex-1">
        {/* A tecla sobe para a linha do rótulo: em meia largura ela roubava do
            nome justamente o espaço que "Quem vendeu?" precisa, e o aviso saía
            cortado — que é o oposto de avisar. */}
        <div className="flex items-baseline justify-between gap-2">
          <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
            Vendedor
          </span>
          <Kbd className="shrink-0">F8</Kbd>
        </div>
        {vendedor ? (
          <div className="truncate text-sm font-medium">{vendedor.nome}</div>
        ) : (
          <div className="truncate text-sm font-medium text-destructive">
            {vendedorCodigo.trim() ? "Não encontrado" : "Quem vendeu?"}
          </div>
        )}
      </div>
    </div>
  );

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Finalizar venda"
      className="absolute inset-0 z-40 flex items-center justify-center bg-background/80 p-4 backdrop-blur-sm sm:p-6"
    >
      {/*
        Três faixas em vez de uma coluna que cresce: cabeçalho e botão ficam
        parados, e só o meio rola. O botão de fechar a venda é a única coisa que
        SEMPRE precisa estar à mão — com tudo numa coluna só, bastava a venda
        ter cliente, vendedor, CPF na nota e escolha de documento para ele cair
        abaixo da dobra, e quem está com o cliente na frente tinha de rolar para
        cobrar.
      */}
      <div className="flex max-h-full w-full max-w-lg flex-col overflow-hidden rounded-xl border border-border bg-card shadow-xl">
        <div className="shrink-0 px-6 pt-6">
          <div className="flex items-baseline justify-between">
            <h2 className="text-base font-semibold">Finalizar venda</h2>
            <span className="text-xs text-muted-foreground">
              <Kbd>Esc</Kbd> volta ao carrinho
            </span>
          </div>
        </div>

        {/* `min-h-0` é o que permite encolher dentro do flex — sem ele o meio
            empurra as faixas para fora da tela em vez de rolar. */}
        <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-2">

        <div className="mt-3 flex items-baseline justify-between">
          <span className="text-xs text-muted-foreground">
            {itens} {itens === 1 ? "item" : "itens"} · {volumes}{" "}
            {volumes === 1 ? "volume" : "volumes"}
          </span>
          <span className="font-mono text-4xl font-bold tracking-tight tabular-nums">
            {moeda(total)}
          </span>
        </div>

        {/*
          O crédito aparece só quando existe, e some quando o saldo é zero: uma
          linha permanente dizendo "crédito R$ 0,00" ensinaria o caixa a ignorar
          a região em que a informação às vezes aparece.

          Um botão, e não um campo de digitar: o caso é abater tudo que der, e
          quando não der tudo é porque o total é menor — aí o teto já é o total.
          Quem quiser guardar o saldo clica de novo e volta a zero.
        */}
        {creditoDisponivel > 0 ? (
          <div className="mt-3 flex flex-wrap items-center gap-2 rounded-lg border border-border bg-muted/30 p-3">
            <Wallet className="size-4 shrink-0 text-muted-foreground" aria-hidden />
            <span className="text-xs">
              {cliente?.nome} tem{" "}
              <b className="font-semibold">{moeda(saldo)}</b> de crédito
            </span>
            <Button
              type="button"
              tabIndex={-1}
              size="xs"
              variant={credito > 0 ? "default" : "outline"}
              onClick={() => onCreditoUsadoChange(credito > 0 ? 0 : creditoDisponivel)}
              className="ml-auto rounded-lg"
            >
              {credito > 0 ? "Não usar" : `Abater ${moeda(creditoDisponivel)}`}
            </Button>
          </div>
        ) : null}

        {credito > 0 ? (
          <div className="mt-2 flex items-baseline justify-between text-sm">
            <span className="text-muted-foreground">A pagar depois do crédito</span>
            <span className="font-mono text-xl font-bold tabular-nums">{moeda(aPagar)}</span>
          </div>
        ) : null}

        <Separator className="my-4" />

        <div className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
          {paraARede ? "Saída" : "Pagamento"}
        </div>

        {paraARede ? (
          /*
            Nenhum botão: não há o que escolher. O painel diz o que vai
            acontecer, porque uma grade desabilitada faria o caixa procurar qual
            forma marcar — e a resposta é "nenhuma, isto não é pagamento".
          */
          <div className="flex items-start gap-3 rounded-lg border border-border bg-muted/40 p-3">
            <Truck
              className="mt-0.5 size-4 shrink-0 text-muted-foreground"
              aria-hidden
            />
            <div className="text-xs leading-relaxed">
              <p className="font-medium">
                Transferência para {cliente?.lojaDaRede} — não é venda
              </p>
              <p className="mt-0.5 text-muted-foreground">
                A nota sai pelo custo, só para acompanhar a mercadoria. Não baixa
                estoque (quem baixa é a transferência), não entra no caixa nem no
                faturamento, e não gera comissão.
              </p>
            </div>
          </div>
        ) : (
        <div className="grid grid-cols-3 gap-2">
          {FORMAS_DE_CAIXA.map((opcao, indice) => {
            const Icone = ICONES[opcao.id];
            const escolhida = opcao.id === forma;
            return (
              <Button
                key={opcao.id}
                type="button"
                tabIndex={-1}
                variant={escolhida ? "default" : "outline"}
                size="sm"
                onClick={() => onFormaChange(opcao.id)}
                className="justify-start rounded-lg"
              >
                <Icone className="size-4" />
                <span className="flex-1 text-left">{opcao.rotulo}</span>
                <Kbd
                  className={cn(
                    "text-[9px]",
                    escolhida &&
                      "bg-primary-foreground/20 text-primary-foreground",
                  )}
                >
                  ⇧F{indice + 1}
                </Kbd>
              </Button>
            );
          })}
        </div>
        )}

        {emDinheiro ? (
          <div className="mt-3 flex items-center gap-3 rounded-lg border border-border bg-muted/30 p-3">
            <label
              htmlFor="recebido"
              className="shrink-0 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground"
            >
              Recebido
            </label>
            <Input
              ref={campoRecebido}
              id="recebido"
              type="search"
              value={recebido}
              onChange={(e) => onRecebidoChange(e.target.value)}
              placeholder="quanto o cliente entregou"
              inputMode="decimal"
              autoComplete="off"
              data-1p-ignore=""
              data-lpignore="true"
              className="h-9 flex-1 rounded-lg font-mono text-lg tabular-nums"
            />
            <div className="shrink-0 text-right">
              <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                {troco !== null && troco < 0 ? "Falta" : "Troco"}
              </div>
              <div
                className={cn(
                  "font-mono text-xl font-bold tabular-nums",
                  troco !== null && troco < 0 && "text-destructive",
                )}
              >
                {troco === null ? "—" : moeda(Math.abs(troco))}
              </div>
            </div>
          </div>
        ) : null}

        <Separator className="my-4" />

        {/* Combobox: a busca e a lista aparecem no lugar da linha, sem outro
            diálogo por cima — o total continua à vista enquanto se escolhe.
            Escolhendo cliente a grade vira uma coluna: a lista precisa da
            largura inteira, e o vendedor sobe para cima dela. */}
        <div className={cn("grid gap-2", !escolhendoCliente && "sm:grid-cols-2")}>
          {cartaoVendedor}
          {escolhendoCliente ? (
          <div className="rounded-lg border border-primary bg-card p-2">
            <div className="flex items-center gap-2 px-1">
              <Search
                className="size-4 shrink-0 text-muted-foreground"
                aria-hidden
              />
              <Input
                ref={campoCliente}
                type="search"
                role="combobox"
                aria-expanded="true"
                aria-controls="lista-clientes"
                value={buscaCliente}
                onChange={(e) => setBuscaCliente(e.target.value)}
                placeholder="Nome ou CPF/CNPJ… (Esc volta)"
                aria-label="Buscar cliente"
                autoComplete="off"
                data-1p-ignore=""
                data-lpignore="true"
                className="h-9 flex-1 rounded-none border-0 bg-transparent px-0 shadow-none focus-visible:border-transparent focus-visible:ring-0"
              />
              <Button
                type="button"
                tabIndex={-1}
                variant="outline"
                size="xs"
                onClick={onCadastrarCliente}
                className="shrink-0 rounded-lg"
              >
                <UserPlus className="size-3.5" />
                Novo <Kbd className="text-[9px]">F2</Kbd>
              </Button>
            </div>

            <ul
              id="lista-clientes"
              role="listbox"
              aria-label="Clientes"
              className="mt-1 max-h-56 overflow-y-auto"
            >
              {opcoes.map((opcao, i) => {
                const ativo = i === indiceCliente;
                return (
                  <li
                    key={opcao?.id ?? "consumidor"}
                    role="option"
                    aria-selected={ativo}
                  >
                    <button
                      type="button"
                      tabIndex={-1}
                      onMouseEnter={() => setIndiceCliente(i)}
                      onClick={() => {
                        onClienteChange(opcao);
                        setEscolhendoCliente(false);
                        setBuscaCliente("");
                      }}
                      className={cn(
                        "flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm transition-colors",
                        ativo ? "bg-accent" : "hover:bg-muted/60",
                      )}
                    >
                      {opcao === null ? (
                        <>
                          <User
                            className="size-4 shrink-0 text-muted-foreground"
                            aria-hidden
                          />
                          <span className="font-medium">Consumidor Final</span>
                          <span className="ml-auto text-[10px] text-muted-foreground">
                            sem identificação
                          </span>
                        </>
                      ) : (
                        <>
                          <span className="min-w-0 flex-1 truncate">
                            {opcao.nome}
                          </span>
                          <span className="shrink-0 font-mono text-[11px] text-muted-foreground tabular-nums">
                            {formatarCpfCnpj(opcao.cpfCnpj)}
                          </span>
                          <Badge
                            variant="outline"
                            className="shrink-0 text-[9px]"
                          >
                            {opcao.cidade}/{opcao.uf}
                          </Badge>
                        </>
                      )}
                    </button>
                  </li>
                );
              })}
              {opcoes.length === 1 ? (
                <li className="px-2 py-3 text-center text-xs text-muted-foreground">
                  Nenhum cliente com “{buscaCliente}” · <Kbd>F2</Kbd> cadastra
                </li>
              ) : null}
            </ul>
          </div>
        ) : (
          <button
            type="button"
            tabIndex={-1}
            onClick={() => {
              setBuscaCliente("");
              setEscolhendoCliente(true);
            }}
            className={cn(
              "flex w-full items-center gap-3 rounded-lg border p-3 text-left transition-colors hover:bg-muted/60",
              faltaCliente
                ? "border-destructive/40 bg-destructive/5"
                : "border-border",
            )}
          >
            <User
              className="size-4 shrink-0 text-muted-foreground"
              aria-hidden
            />
            <div className="min-w-0 flex-1">
              <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                Cliente
              </div>
              {cliente ? (
                <>
                  <div className="truncate text-sm font-medium">
                    {cliente.nome}
                  </div>
                  <div className="font-mono text-[11px] text-muted-foreground tabular-nums">
                    {formatarCpfCnpj(cliente.cpfCnpj)}
                  </div>
                </>
              ) : (
                <div
                  className={cn(
                    "text-sm font-medium",
                    faltaCliente ? "text-destructive" : "text-foreground",
                  )}
                >
                  {faltaCliente ? "A prazo exige cliente" : "Consumidor Final"}
                </div>
              )}
            </div>
            <Kbd className="shrink-0">F6</Kbd>
          </button>
          )}
        </div>

        {/*
          O CPF na nota é outra coisa que o cliente: quem pede crédito da Nota
          Legal informa o CPF, leva o cupom e vai embora — não quer cadastro, e
          obrigar a um seria perder a venda por causa de um formulário. Some da
          tela quando há cliente vinculado, porque aí o documento é o dele.
        */}
        {!cliente && fiscal.emite ? (
          <div
            className={cn(
              "mt-2 flex items-center gap-3 rounded-lg border p-3",
              cpfInvalido ? "border-destructive/40 bg-destructive/5" : "border-border"
            )}
          >
            <IdCard className="size-4 shrink-0 text-muted-foreground" aria-hidden />
            <div className="min-w-0 flex-1">
              <label
                htmlFor="cpf-na-nota"
                className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground"
              >
                CPF na nota
              </label>
              <Input
                id="cpf-na-nota"
                ref={campoCpf}
                value={cpfNaNota}
                onChange={(evento) => onCpfNaNotaChange(mascararCpfCnpj(evento.target.value))}
                placeholder="000.000.000-00"
                inputMode="numeric"
                autoComplete="off"
                aria-invalid={cpfInvalido || undefined}
                className="mt-0.5 h-8 rounded-lg border-0 bg-transparent px-0 font-mono text-sm tabular-nums shadow-none focus-visible:ring-0"
              />
            </div>
            <span className="shrink-0 text-[10px] text-muted-foreground">
              {cpfInvalido ? "CPF inválido" : "Nota Legal · opcional"}
            </span>
            <Kbd className="shrink-0">F2</Kbd>
          </div>
        ) : null}

        {/*
          Um cartão só, e não dois: emitir a nota e imprimir o papel pareciam
          duas escolhas independentes, e dois cartões acesos liam-se como dois
          documentos saindo. São uma coisa só — o que esta venda produz —, e por
          isso giram num ciclo: documento fiscal, cupom, nada.
        */}
        <button
          type="button"
          tabIndex={-1}
          onClick={girarSaida}
          className={cn(
            "mt-2 flex w-full items-center gap-3 rounded-lg border p-3 text-left transition-colors hover:bg-muted/60",
            saida.destaque ? "border-primary bg-primary/5" : "border-dashed border-border"
          )}
        >
          {saida.estado === "nada" ? (
            <Printer className="size-4 shrink-0 text-muted-foreground" aria-hidden />
          ) : saida.estado === "cupom" ? (
            <Printer className="size-4 shrink-0 text-muted-foreground" aria-hidden />
          ) : (
            <FileText className="size-4 shrink-0 text-muted-foreground" aria-hidden />
          )}
          <div className="min-w-0 flex-1">
            <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
              {saida.rotulo}
            </div>
            <div className="text-sm font-medium">{saida.situacao}</div>
            {saida.aviso ? (
              <div className="text-[10px] text-muted-foreground">{saida.aviso}</div>
            ) : null}
          </div>
          <Kbd className="shrink-0">F7</Kbd>
        </button>

        {erro ? (
          <p className="mt-3 text-xs font-medium text-destructive" role="alert">
            {erro}
          </p>
        ) : null}

        </div>

        <div className="shrink-0 border-t border-border px-6 pb-6 pt-4">
        <Button
          type="button"
          tabIndex={-1}
          size="lg"
          disabled={gravando || faltaDinheiro || faltaCliente || faltaVendedor || cpfInvalido}
          onClick={onConfirmar}
          className="h-14 w-full rounded-xl text-base font-semibold"
        >
          {gravando ? (
            "GRAVANDO…"
          ) : (
            <>
              {aPrazo
                ? "ESCOLHER O PRAZO"
                : forma === "pix"
                  ? "GERAR O PIX"
                  : "FINALIZAR"}
              <Kbd className="bg-primary-foreground/20 text-primary-foreground">
                Enter
              </Kbd>
            </>
          )}
        </Button>

        {faltaDinheiro && valorRecebido !== null ? (
          <p className="mt-2 text-center text-xs text-muted-foreground">
            Faltam {moeda(Math.abs(troco ?? 0))} para fechar
          </p>
        ) : null}
        </div>
      </div>
    </div>
  );
}
