import Link, {type LinkProps} from 'next/link';
import type {AnchorHTMLAttributes,ReactNode} from 'react';

type WorkspaceLinkProps=Readonly<Omit<LinkProps,'prefetch'> & Omit<AnchorHTMLAttributes<HTMLAnchorElement>,'href'> & {children:ReactNode}>;

/** Internal operator navigation: client transitions without speculative RSC work. */
export function WorkspaceLink({children,...props}:WorkspaceLinkProps){return <Link {...props} prefetch={false}>{children}</Link>;}
