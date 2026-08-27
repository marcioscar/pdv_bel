import { useEffect, useRef } from "react";
import { ShoppingCart } from "lucide-react";

import { Badge } from "~/components/ui/badge";
import { Kbd } from "~/components/ui/kbd";
import { cn } from "~/lib/utils";
import { moeda, quantidade as formatarQuantidade } from "~/lib/moeda";
import { precoAplicado, type ItemVenda } from "~/lib/pdv";

type Props = {
	itens: ItemVenda[];
	indiceAtivo: number;
	onSelecionar: (indice: number) => void;
};

export function ListaItens({ itens, indiceAtivo, onSelecionar }: Props) {
	const linhaAtiva = useRef<HTMLTableRowElement>(null);

	// A linha ativa é movida pelo teclado, então ela precisa se manter visível.
	useEffect(() => {
		linhaAtiva.current?.scrollIntoView({ block: "nearest" });
	}, [indiceAtivo]);

	if (itens.length === 0) {
		return (
			<div className='flex flex-1 flex-col items-center justify-center gap-3 text-center'>
				<ShoppingCart
					className='size-10 text-muted-foreground/40'
					aria-hidden
				/>
				<p className='text-sm text-muted-foreground'>Nenhum item na venda</p>
				<p className='text-xs text-muted-foreground'>
					<Kbd>F1</Kbd> mostra todos os atalhos
				</p>
			</div>
		);
	}

	return (
		<div className='flex-1 overflow-y-auto'>
			<table className='w-full text-sm'>
				<thead className='sticky top-0 z-10 bg-card'>
					<tr className='border-b border-border text-[10px] font-semibold uppercase tracking-wider text-muted-foreground'>
						<th
							scope='col'
							className='w-12 px-5 py-2.5 text-left font-semibold'>
							#
						</th>
						<th scope='col' className='px-2 py-2.5 text-left font-semibold'>
							Produto
						</th>
						<th
							scope='col'
							className='w-16 px-2 py-2.5 text-left font-semibold'>
							Un.
						</th>
						<th
							scope='col'
							className='w-20 px-2 py-2.5 text-right font-semibold'>
							Qtd
						</th>
						<th
							scope='col'
							className='w-28 px-2 py-2.5 text-right font-semibold'>
							Unit.
						</th>
						<th
							scope='col'
							className='w-32 px-5 py-2.5 text-right font-semibold'>
							Subtotal
						</th>
					</tr>
				</thead>
				<tbody>
					{itens.map((item, indice) => {
						const ativo = indice === indiceAtivo;
						const semEstoque = item.quantidade > item.estoque;
						const { preco, combo } = precoAplicado(item, item.quantidade);
						return (
							<tr
								key={item.produtoId}
								ref={ativo ? linhaAtiva : undefined}
								onClick={() => onSelecionar(indice)}
								aria-current={ativo ? "true" : undefined}
								className={cn(
									"cursor-default border-b border-border transition-colors",
									ativo
										? "bg-accent shadow-[inset_3px_0_0_var(--primary)]"
										: "hover:bg-muted/40",
								)}>
								<td className='px-5 py-3 font-mono text-xs text-muted-foreground tabular-nums'>
									{indice + 1}
								</td>
								<td className='px-2 py-3'>
									<div className='font-medium'>{item.descricao}</div>
									<div className='mt-0.5 font-mono text-[11px] text-muted-foreground'>
										cód. {item.codigo} · estoque{" "}
										<span
											className={cn(
												semEstoque && "font-semibold text-destructive",
											)}>
											{formatarQuantidade(item.estoque)}
										</span>
									</div>
								</td>
								<td className='px-2 py-3'>
									<Badge variant='outline' className='font-mono text-[10px]'>
										{item.unidade}
									</Badge>
								</td>
								<td
									className={cn(
										"px-2 py-3 text-right font-mono tabular-nums",
										semEstoque && "font-semibold text-destructive",
									)}
									title={
										semEstoque ? "Quantidade acima do estoque" : undefined
									}>
									{formatarQuantidade(item.quantidade)}
								</td>
								{/* O preço muda sozinho quando a quantidade cruza o degrau;
								    sem dizer por quê, o operador vê o valor mudar e desconfia. */}
								<td className='px-2 py-3 text-right font-mono tabular-nums'>
									<div className={cn(combo ? "font-semibold text-emerald-600 dark:text-emerald-500" : "text-muted-foreground")}>
										{moeda(preco)}
									</div>
									{combo ? (
										<div className='text-[10px] font-sans text-emerald-600 dark:text-emerald-500'>
											combo · {formatarQuantidade(item.quantidadeCombo ?? 0)}+
										</div>
									) : null}
								</td>
								<td className='px-5 py-3 text-right font-mono font-medium tabular-nums'>
									{moeda(preco * item.quantidade)}
								</td>
							</tr>
						);
					})}
				</tbody>
			</table>
		</div>
	);
}
