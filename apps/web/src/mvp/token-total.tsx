/** Observed lower bound, never a claim of complete Hermes/billing coverage. */
export function TokenTotal({total}:Readonly<{total:number|null|undefined}>){return <span title="Нижняя граница расхода по доступным наблюдениям. Полный расход ИИ-агента пока не подтверждён.">{total==null?'Нет данных':`${new Intl.NumberFormat('ru-RU').format(total)} · Учтено частично`}</span>;}
