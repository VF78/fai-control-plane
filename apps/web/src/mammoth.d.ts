declare module 'mammoth' {
  export function extractRawText(input: Readonly<{buffer: Buffer}>): Promise<Readonly<{value: string; messages: readonly Readonly<{type: 'warning' | 'error'; message: string}>[]}>>;
}
