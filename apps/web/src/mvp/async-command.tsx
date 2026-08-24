'use client';

import {forwardRef, useRef, useState, type ButtonHTMLAttributes, type ReactNode} from 'react';
import {useRouter} from 'next/navigation';

export type CommandNotice = Readonly<{tone: 'success'|'error'; text: string}>;
type Options<T> = Readonly<{success?: string | ((result: T) => string); error?: string | ((error: unknown) => string); refresh?: boolean}>;

/** The only client-side contract for an operator command: one in-flight request, a visible result, and a refresh on success. */
export function useAsyncCommand() {
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState<CommandNotice|null>(null);
  const inFlight = useRef(false);
  const router = useRouter();
  const run = async <T,>(request: () => Promise<T>, options: Options<T> = {}): Promise<T|undefined> => {
    if (inFlight.current) return undefined;
    inFlight.current = true; setPending(true); setNotice(null);
    try { const result = await request(); const text = typeof options.success === 'function' ? options.success(result) : options.success ?? 'Изменение сохранено.'; setNotice({tone: 'success', text}); if (options.refresh !== false) router.refresh(); return result;
    } catch (error) { const text = typeof options.error === 'function' ? options.error(error) : options.error ?? 'Не удалось выполнить действие. Данные не изменены.'; setNotice({tone: 'error', text}); return undefined;
    } finally { inFlight.current = false; setPending(false); }
  };
  return {pending, notice, run};
}

type AsyncButtonProps = Readonly<{pending: boolean; pendingLabel: string; children: ReactNode;} & ButtonHTMLAttributes<HTMLButtonElement>>;
export const AsyncButton = forwardRef<HTMLButtonElement, AsyncButtonProps>(function AsyncButton({pending, pendingLabel, children, disabled, className = 'fcp-primary', ...props}, ref) {
  return <button {...props} ref={ref} className={className} disabled={pending || disabled} aria-busy={pending || undefined}>{pending ? <><span className="fcp-button-spinner" aria-hidden="true"/>{pendingLabel}</> : children}</button>;
});

export function CommandNoticeView({notice}: Readonly<{notice: CommandNotice|null}>) {
  return notice === null ? null : <p className={`fcp-command-notice ${notice.tone}`} role={notice.tone === 'error' ? 'alert' : 'status'}>{notice.text}</p>;
}
