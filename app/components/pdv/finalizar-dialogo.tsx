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
import { FORMAS_PAGAMENTO, type FormaPagamento } from "~/lib/pdv";
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
};

type Props = {
  total: number;
  volumes: number;
  itens: number;
  forma: FormaPagamento;
  onFormaChange: (forma: FormaPagamento) => void;
  recebido: string;
  onRecebidoChange: (valor: string) => void;
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

  const emDinheiro = forma === "dinheiro";
  const aPrazo = forma === "prazo";
  const valorRecebido = interpretarValor(recebido);
  const troco = valorRecebido === null ? null : valorRecebido - total;
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
  const faltaVendedor = vendedor === null;

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
          c.nome
            .normalize("NFD")
            .replace(/[\u0300-\u036f]/g, "")
            .toLowerCase()
            .includes(termo) ||
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
        const posicao = FORMAS_PAGAMENTO.findIndex(
          (_, i) => key === `F${i + 1}`,
        );
        if (posicao >= 0) {
          evento.preventDefault();
          onFormaChange(FORMAS_PAGAMENTO[posicao].id);
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
      if (key === "F7") {
        evento.preventDefault();
        onImprimirChange(!imprimir);
        return;
      }
      /*
       * F4, e não F5: F5 é recarregar a página no navegador, e mesmo com
       * preventDefault a tecla é arriscada demais para uma escolha que muda o
       * que sai impresso. F4 está livre dentro da conferência.
       */
      if (key === "F4" && fiscal.emite) {
        evento.preventDefault();
        onEmitirNotaChange(!emitirNota);
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
   * O que sai na bobina.
   *
   * Um cartão só, porque é um papel só: com a NFC-e valendo, quem sai é o DANFE
   * dela — o cupom não fiscal seria um segundo documento dizendo a mesma coisa.
   * Dizer "Cupom" ali era mentira quando a nota estava ligada, e dois cartões
   * marcados davam a impressão de dois papéis.
   */
  const papel = (() => {
    if (!imprimir) return "não imprimir";
    const nfceVale =
      fiscal.emite &&
      emitirNota &&
      fiscal.producao &&
      modeloDaVenda({ forma, clienteCpfCnpj: cliente?.cpfCnpj ?? null }) === "nfce";
    return nfceVale ? "DANFE da NFC-e" : "cupom não fiscal";
  })();

  const nota = (() => {
    if (!fiscal.emite) {
      return {
        rotulo: "Nota fiscal",
        situacao: "esta loja ainda não emite",
        aviso: null as string | null,
      }
    }

    const modelo = modeloDaVenda({ forma, clienteCpfCnpj: cliente?.cpfCnpj ?? null })
    const rotulo = modelo === "nfe" ? "NF-e" : "NFC-e"

    if (!emitirNota) {
      return { rotulo, situacao: "não emitir", aviso: null }
    }

    return {
      rotulo,
      situacao: fiscal.producao ? "emitir com a venda" : "emitir com a venda (teste)",
      // A NF-e emitida aqui sai sem frete e sem observação, e não se corrige
      // depois. Quem precisa dos dois desliga e emite pela tela de Vendas.
      aviso: modelo === "nfe" ? "sem frete e sem observação" : null,
    }
  })()

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Finalizar venda"
      className="absolute inset-0 z-40 flex items-start justify-center overflow-y-auto bg-background/80 p-8 backdrop-blur-sm"
    >
      <div className="w-full max-w-lg rounded-xl border border-border bg-card p-6 shadow-xl">
        <div className="flex items-baseline justify-between">
          <h2 className="text-base font-semibold">Finalizar venda</h2>
          <span className="text-xs text-muted-foreground">
            <Kbd>Esc</Kbd> volta ao carrinho
          </span>
        </div>

        <div className="mt-3 flex items-baseline justify-between">
          <span className="text-xs text-muted-foreground">
            {itens} {itens === 1 ? "item" : "itens"} · {volumes}{" "}
            {volumes === 1 ? "volume" : "volumes"}
          </span>
          <span className="font-mono text-4xl font-bold tracking-tight tabular-nums">
            {moeda(total)}
          </span>
        </div>

        <Separator className="my-4" />

        <div className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
          Pagamento
        </div>
        <div className="grid grid-cols-3 gap-2">
          {FORMAS_PAGAMENTO.map((opcao, indice) => {
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

        {/* Obrigatório e sem padrão: quem fecha é um caixa fixo e quem vendeu
            muda de cliente para cliente. Um valor "lembrado" da venda anterior
            creditaria a comissão errada em silêncio. */}
        <div
          className={cn(
            "mt-3 flex items-center gap-3 rounded-lg border p-3",
            faltaVendedor ? "border-destructive/50 bg-destructive/5" : "border-border bg-muted/30",
          )}
        >
          <label
            htmlFor="vendedor"
            className="shrink-0 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground"
          >
            Vendedor
          </label>
          <Input
            ref={campoVendedor}
            id="vendedor"
            type="search"
            value={vendedorCodigo}
            onChange={(e) => onVendedorCodigoChange(e.target.value)}
            placeholder="código"
            inputMode="numeric"
            autoComplete="off"
            data-1p-ignore=""
            data-lpignore="true"
            className="h-9 w-24 rounded-lg font-mono text-lg tabular-nums"
          />
          <div className="min-w-0 flex-1 text-right">
            {vendedor ? (
              <div className="truncate text-sm font-medium">{vendedor.nome}</div>
            ) : (
              <div className="text-sm font-medium text-destructive">
                {vendedorCodigo.trim() ? "Código não encontrado" : "Quem vendeu?"}
              </div>
            )}
          </div>
          <Kbd className="shrink-0">F8</Kbd>
        </div>

        <Separator className="my-4" />

        {/* Combobox: a busca e a lista aparecem no lugar da linha, sem outro
            diálogo por cima — o total continua à vista enquanto se escolhe. */}
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

        <div className="mt-2 grid grid-cols-2 gap-2">
          <button
            type="button"
            tabIndex={-1}
            onClick={() => onImprimirChange(!imprimir)}
            className={cn(
              "flex items-center gap-2 rounded-lg border p-3 text-left transition-colors hover:bg-muted/60",
              imprimir ? "border-primary bg-primary/5" : "border-border",
            )}
          >
            <Printer
              className="size-4 shrink-0 text-muted-foreground"
              aria-hidden
            />
            <div className="min-w-0 flex-1">
              <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                Papel
              </div>
              <div className="text-sm font-medium">{papel}</div>
            </div>
            <Kbd className="shrink-0">F7</Kbd>
          </button>

          {/* O MODELO não se escolhe — quem decide é o cliente e a forma de
              pagamento. Emitir, sim: venda que o cliente não quer nota, teste,
              conferência de caixa. O documento fiscal é a regra, então começa
              ligado; desligar é ato consciente de quem fecha. */}
          <button
            type="button"
            tabIndex={-1}
            disabled={!fiscal.emite}
            onClick={() => onEmitirNotaChange(!emitirNota)}
            className={cn(
              "flex items-center gap-2 rounded-lg border p-3 text-left transition-colors",
              !fiscal.emite
                ? "border-dashed border-border opacity-60"
                : emitirNota
                  ? "border-primary bg-primary/5"
                  : "border-dashed border-border"
            )}
          >
            <FileText className="size-4 shrink-0 text-muted-foreground" aria-hidden />
            <div className="min-w-0 flex-1">
              <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                {nota.rotulo}
              </div>
              <div className="text-sm font-medium">{nota.situacao}</div>
              {nota.aviso ? (
                <div className="text-[10px] text-muted-foreground">{nota.aviso}</div>
              ) : null}
            </div>
            {fiscal.emite ? <Kbd className="shrink-0">F4</Kbd> : null}
          </button>
        </div>

        {erro ? (
          <p className="mt-3 text-xs font-medium text-destructive" role="alert">
            {erro}
          </p>
        ) : null}

        <Separator className="my-4" />

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
  );
}
