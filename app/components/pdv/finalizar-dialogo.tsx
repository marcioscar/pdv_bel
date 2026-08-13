import { useEffect, useMemo, useRef, useState } from "react";
import {
  Banknote,
  CalendarClock,
  CreditCard,
  FileText,
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
import { formatarCpfCnpj } from "~/lib/documento";
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
};

type Props = {
  total: number;
  volumes: number;
  itens: number;
  forma: FormaPagamento;
  onFormaChange: (forma: FormaPagamento) => void;
  recebido: string;
  onRecebidoChange: (valor: string) => void;
  cliente: ClienteResumo | null;
  /** Lista para escolher aqui dentro, sem abrir outro diálogo por cima. */
  clientes: ClienteResumo[];
  onClienteChange: (cliente: ClienteResumo | null) => void;
  /** Cadastro de cliente novo: exige endereço, então tem tela própria. */
  onCadastrarCliente: () => void;
  imprimir: boolean;
  onImprimirChange: (imprimir: boolean) => void;
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
  cliente,
  clientes,
  onClienteChange,
  onCadastrarCliente,
  imprimir,
  onImprimirChange,
  gravando,
  erro,
  onConfirmar,
  onFechar,
  pausado = false,
}: Props) {
  const campoRecebido = useRef<HTMLInputElement>(null);
  const campoCliente = useRef<HTMLInputElement>(null);

  const emDinheiro = forma === "dinheiro";
  const aPrazo = forma === "prazo";
  const valorRecebido = interpretarValor(recebido);
  const troco = valorRecebido === null ? null : valorRecebido - total;
  const faltaDinheiro =
    emDinheiro && (valorRecebido === null || troco === null || troco < 0);
  const faltaCliente = aPrazo && cliente === null;

  /**
   * A escolha do cliente acontece AQUI DENTRO, trocando esta seção por uma busca.
   *
   * Antes ela abria outro diálogo por cima deste: dois modais empilhados, o
   * operador perdendo de vista o total que ia cobrar, e duas telas disputando o
   * teclado. Cadastrar cliente novo continua tendo tela própria — exige endereço
   * completo, que o boleto recusa pela metade.
   */
  const [escolhendoCliente, setEscolhendoCliente] = useState(false);
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
        onConfirmar();
        return;
      }
      if (key === "F6") {
        evento.preventDefault();
        setBuscaCliente("");
        setEscolhendoCliente(true);
        return;
      }
      if (key === "F7") {
        evento.preventDefault();
        onImprimirChange(!imprimir);
      }
    }

    window.addEventListener("keydown", aoTeclar, true);
    return () => window.removeEventListener("keydown", aoTeclar, true);
  }, [
    escolhendoCliente,
    imprimir,
    indiceCliente,
    onCadastrarCliente,
    onClienteChange,
    onConfirmar,
    onFechar,
    onFormaChange,
    onImprimirChange,
    opcoes,
    pausado,
  ]);

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
                Cupom
              </div>
              <div className="text-sm font-medium">
                {imprimir ? "Imprimir" : "Não imprimir"}
              </div>
            </div>
            <Kbd className="shrink-0">F7</Kbd>
          </button>

          {/* Desabilitado a propósito: NF-e é projeto à parte (certificado A1,
              SEFAZ, contingência), não um botão. O lugar dela já fica definido. */}
          <div className="flex items-center gap-2 rounded-lg border border-dashed border-border p-3 opacity-50">
            <FileText
              className="size-4 shrink-0 text-muted-foreground"
              aria-hidden
            />
            <div className="min-w-0 flex-1">
              <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                NF-e
              </div>
              <div className="text-sm font-medium">em breve</div>
            </div>
          </div>
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
          disabled={gravando || faltaDinheiro || faltaCliente}
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
