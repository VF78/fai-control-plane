/** Web tokens are deliberately framework-neutral so native reuse is a later
 * styling exercise rather than a domain migration. */
export const operatorTokens = {
  color: {
    canvas: '#ffffff', surface: '#f6f8fa', ink: '#1f2328', muted: '#59636e',
    border: '#d0d7de', focus: '#0969da', danger: '#cf222e', warning: '#9a6700', success: '#1a7f37'
  },
  space: {xs: 4, sm: 8, md: 16, lg: 24, xl: 32},
  target: {minimum: 44}
} as const;
