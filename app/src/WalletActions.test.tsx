import { render,screen } from '@testing-library/react';
import { describe,expect,it,vi } from 'vitest';
import { RequestActions } from './WalletActions';
import { request } from './test/fixtures';
import type { PublicTransactions } from './wallet';

describe('explicit voting gate and refund eligibility UI',()=>{it('never enables vote execution and exposes refund only to an eligible author',()=>{const transactions={} as PublicTransactions;const {rerender}=render(<RequestActions request={request} account={request.author} transactions={transactions} onSuccess={vi.fn()}/>);expect(screen.getByText(/Voting execution disabled by safety gate/)).toBeInTheDocument();expect(screen.getByRole('button',{name:/SUPPORT unavailable/})).toBeDisabled();expect(screen.getByRole('button',{name:/OPPOSE unavailable/})).toBeDisabled();expect(screen.getByRole('button',{name:'Review refund'})).toBeEnabled();rerender(<RequestActions request={{...request,bond:{...request.bond,state:'locked'}}} account={request.author} transactions={transactions} onSuccess={vi.fn()}/>);expect(screen.queryByRole('button',{name:'Review refund'})).not.toBeInTheDocument();expect(screen.getByText(/not currently refundable/)).toBeInTheDocument()})});
