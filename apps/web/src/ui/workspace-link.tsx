import Link, {type LinkProps} from 'next/link';
import type {AnchorHTMLAttributes,ReactNode} from 'react';

type WorkspaceLinkProps=Readonly<LinkProps & Omit<AnchorHTMLAttributes<HTMLAnchorElement>,'href'> & {children:ReactNode}>;

/** Internal operator navigation; speculative work stays off unless a stable route opts in. */
export function WorkspaceLink({children,prefetch=false,...props}:WorkspaceLinkProps){return <Link {...props} prefetch={prefetch}>{children}</Link>;}
