import { ScanLine } from "lucide-react";

import { Badge } from "~/components/ui/badge";
import { Input } from "~/components/ui/input";
import { Kbd } from "~/components/ui/kbd";
import { cn } from "~/lib/utils";
import { moeda, quantidade } from "~/lib/moeda";
import { precoAplicado, type ProdutoCatalogo } from "~/lib/pdv";

export type ModoComando = "busca" | "quantidade" | "desconto" | "recebido";

const PROMPTS: Record<ModoComando, { rotulo: string | null; dica: string }> = {
	busca: {
		rotulo: null,
		dica: "Digite o código ou a descrição, ou use 3*141 para 3 unidades…",
	},
	quantidade: { rotulo: "Quantidade", dica: "Nova quantidade do item ativo" },
	desconto: {
		rotulo: "Desconto R$",
		dica: "Valor de desconto sobre o subtotal",
	},
	recebido: { rotulo: "Recebido R$", dica: "Valor entregue pelo cliente" },
};

type Props = {
	ref: React.Ref<HTMLInputElement>;
	modo: ModoComando;
	valor: string;
	onValorChange: (valor: string) => void;
	onBlur: () => void;
	resultados: ProdutoCatalogo[];
	indiceResultado: number;
	onEscolherResultado: (indice: number) => void;
	multiplicador: number;
	/**
	 * O produto que o código digitado já identifica sozinho, mostrado à direita
	 * da barra. `null` quando não há um só: código ambíguo abre a lista, e
	 * descrição não tem prévia — a lista dela já mostra tudo isto por linha.
	 *
	 * Opcional porque a tela de entrada de mercadoria usa a mesma barra e já tem
	 * a sua própria faixa com descrição e saldo do produto escolhido.
	 */
	previa?: ProdutoCatalogo | null;
};

export function BarraComando({
	ref,
	modo,
	valor,
	onValorChange,
	onBlur,
	resultados,
	indiceResultado,
	onEscolherResultado,
	multiplicador,
	previa = null,
}: Props) {
	const prompt = PROMPTS[modo];
	const numerico = modo !== "busca";

	return (
		<div className='relative'>
			<div
				className={cn(
					"flex items-center gap-3 border-b border-border px-5 py-3 transition-colors",
					numerico ? "bg-primary/5" : "bg-muted/40",
				)}>
				{prompt.rotulo ? (
					<span className='shrink-0 text-sm font-semibold text-primary'>
						{prompt.rotulo}
					</span>
				) : (
					<ScanLine
						className='size-5 shrink-0 text-muted-foreground'
						aria-hidden
					/>
				)}

				<Input
					ref={ref}
					value={valor}
					onChange={(evento) => onValorChange(evento.target.value)}
					onBlur={onBlur}
					placeholder={prompt.dica}
					aria-label={prompt.dica}
					inputMode={numerico ? "decimal" : "text"}
					/**
					 * `type="search"` não é detalhe: um `type="text"` solto é classificado
					 * pelo AutoFill do Safari como possível campo de login, e o menu
					 * "Senhas do iCloud" abre em cima da lista de produtos enquanto o
					 * operador digita. Campo de busca os gerenciadores deixam em paz.
					 *
					 * Os atributos abaixo cobrem os demais: cada gerenciador só respeita o
					 * seu, e `autocomplete="off"` sozinho é ignorado por todos.
					 */
					type='search'
					autoComplete='off'
					autoCorrect='off'
					autoCapitalize='off'
					spellCheck={false}
					name='comando-pdv'
					data-1p-ignore=''
					data-lpignore='true'
					data-bwignore=''
					data-form-type='other'
					className='h-9 flex-1 rounded-none border-0 bg-transparent px-0 font-mono text-lg tracking-tight tabular-nums shadow-none placeholder:font-sans placeholder:text-sm placeholder:tracking-normal focus-visible:border-transparent focus-visible:ring-0 md:text-lg'
				/>

				{previa && modo === "busca" ? <Previa produto={previa} quantidade={multiplicador} /> : null}

				{multiplicador > 1 && modo === "busca" ? (
					<Badge variant='secondary' className='shrink-0 font-mono'>
						×{multiplicador}
					</Badge>
				) : null}

				<Kbd className='shrink-0'>
					{modo === "busca" ? "Enter" : "Enter aplica"}
				</Kbd>
			</div>

			{resultados.length > 0 ? (
				<ul
					className='absolute inset-x-0 top-full z-20 max-h-80 overflow-y-auto border-b border-border bg-popover shadow-lg'
					role='listbox'
					aria-label='Resultados da busca'>
					{resultados.map((produto, indice) => {
						const ativo = indice === indiceResultado;
						return (
							<li key={produto.id} role='option' aria-selected={ativo}>
								<button
									type='button'
									tabIndex={-1}
									onClick={() => onEscolherResultado(indice)}
									className={cn(
										"flex w-full items-center gap-3 px-5 py-2.5 text-left text-sm transition-colors",
										ativo
											? "bg-accent shadow-[inset_3px_0_0_var(--primary)]"
											: "hover:bg-muted/60",
									)}>
									<span className='w-16 shrink-0 font-mono text-xs text-muted-foreground tabular-nums'>
										{produto.codigo}
									</span>
									<span className='flex-1 truncate'>{produto.descricao}</span>
									<span
										className={cn(
											"w-24 shrink-0 text-right font-mono text-[11px] tabular-nums",
											produto.estoque <= 0
												? "text-destructive"
												: "text-muted-foreground",
										)}>
										{produto.estoque <= 0
											? "sem estoque"
											: `${quantidade(produto.estoque)} em estoque`}
									</span>
									<Badge
										variant='outline'
										className='shrink-0 font-mono text-[10px]'>
										{produto.unidade}
									</Badge>
									<span className='w-24 shrink-0 text-right font-mono tabular-nums'>
										{moeda(produto.preco)}
									</span>
								</button>
							</li>
						);
					})}
				</ul>
			) : null}
		</div>
	);
}

/**
 * A linha do produto na própria barra: descrição, estoque e o preço que ESTA
 * quantidade paga.
 *
 * O preço sai de `precoAplicado`, o mesmo do carrinho: digitar `12*141` num
 * combo de 10 mostra aqui o preço de combo, que é o que vai ser cobrado. Um
 * preço avulso na prévia e o de combo no cupom seria a tela mentindo por
 * antecipação.
 */
function Previa({
	produto,
	quantidade: quantas,
}: {
	produto: ProdutoCatalogo;
	quantidade: number;
}) {
	const { preco, combo } = precoAplicado(produto, quantas);

	return (
		<span className='hidden min-w-0 shrink items-center gap-3 text-xs sm:flex'>
			<span className='max-w-[24ch] truncate text-muted-foreground'>
				{produto.descricao}
			</span>
			<span
				className={cn(
					"shrink-0 font-mono tabular-nums",
					produto.estoque <= 0 ? "font-semibold text-destructive" : "text-muted-foreground",
				)}>
				{produto.estoque <= 0
					? "sem estoque"
					: `${quantidade(produto.estoque)} em estoque`}
			</span>
			<span className='shrink-0 font-mono tabular-nums'>
				{moeda(preco)}
				{combo ? (
					<span className='ml-1 text-[10px] uppercase text-primary'>combo</span>
				) : null}
			</span>
		</span>
	);
}
