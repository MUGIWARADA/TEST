import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from './api';

const dateLabel = (value) => {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString();
};

export default function Accounts() {
  const navigate = useNavigate();
  const [identity, setIdentity] = useState(null);
  const [status, setStatus] = useState(null);
  const [balances, setBalances] = useState(null);
  const [history, setHistory] = useState(null);
  const [wallets, setWallets] = useState([]);
  const [apiKey, setApiKey] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [showModal, setShowModal] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const loadStatus = useCallback(async () => {
    const [identityData, statusData] = await Promise.all([api.getIdentity(), api.getRoqquStatus()]);
    setIdentity(identityData.identity);
    setStatus(statusData);
  }, []);

  useEffect(() => {
    let active = true;
    Promise.all([api.getIdentity(), api.getRoqquStatus()])
      .then(([identityData, statusData]) => {
        if (!active) return;
        setIdentity(identityData.identity);
        setStatus(statusData);
      })
      .catch((err) => { if (active) setError(err?.message || 'Could not load account status.'); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, []);

  const isSample = Boolean(status?.sample_data);
  const isLiveConnected = Boolean(status?.connected && status?.enabled && !isSample);
  const canConnect = Boolean(status?.connectable);
  const hasAccountAccess = isSample || isLiveConnected;

  const handleConnect = async () => {
    setBusy(true); setError(''); setNotice('');
    try {
      const result = await api.connectRoqqu(apiKey.trim());
      setApiKey('');
      await loadStatus();
      setShowModal(false);
      setNotice(`Roqqu API key connected and validated with a read-only wallet request (${result.validation?.wallet_count ?? 0} BTC wallets found).`);
    } catch (err) { setError(err?.message || 'Could not link this Roqqu identity.'); }
    finally { setBusy(false); }
  };

  const handleRefresh = async () => {
    setBusy(true); setError(''); setNotice('');
    try {
      if (isSample) {
        const [balanceData, historyData] = await Promise.all([api.getRoqquBalances(), api.getRoqquHistory()]);
        setBalances(balanceData); setHistory(historyData); setWallets([]);
        setNotice('Sample data only — no live Roqqu account was queried.');
      } else {
        const walletData = await api.getRoqquBalances();
        setBalances(walletData); setHistory(null); setWallets(walletData.wallets || []);
        setNotice(`Read-only wallet list refreshed: ${walletData.wallet_count || 0} wallets across BTC, ETH, and TRX. On-chain lookups are rate-limited by Roqqu.`);
      }
    } catch (err) { setError(err?.message || 'Could not refresh read-only account data.'); }
    finally { setBusy(false); }
  };

  const handleWalletDetails = async (wallet) => {
    setBusy(true); setError(''); setNotice('');
    try {
      const details = await api.getRoqquHistory({ symbol: wallet.token, address: wallet.address });
      setHistory(details);
      setNotice(details.cached ? 'Showing a recent cached blockchain snapshot.' : 'On-chain balance and transaction details loaded. Roqqu limits this endpoint to one lookup every 100 seconds.');
    } catch (err) { setError(err?.message || 'Could not load on-chain wallet details.'); }
    finally { setBusy(false); }
  };

  const handleDisconnect = async () => {
    if (!window.confirm('Disconnect Roqqu from this Miroir identity? This does not change anything in Roqqu.')) return;
    setBusy(true); setError(''); setNotice('');
    try {
      await api.disconnectRoqqu();
      setBalances(null); setHistory(null); setWallets([]);
      await loadStatus();
      setNotice('Roqqu has been disconnected from this Miroir identity.');
    } catch (err) { setError(err?.message || 'Could not disconnect Roqqu.'); }
    finally { setBusy(false); }
  };

  const balanceObject = balances?.balance && typeof balances.balance === 'object' ? balances.balance : null;
  const balanceRows = balanceObject ? Object.entries(balanceObject).filter(([key, value]) => key !== 'updated_at' && (typeof value === 'string' || typeof value === 'number')) : [];
  const historyRows = Array.isArray(history?.history) ? history.history : Array.isArray(history?.data) ? history.data : [];
  const liveTransactions = Array.isArray(history?.transactions) ? history.transactions : [];

  if (loading) return <div className="p-8 text-text-primary flex min-h-[40vh] items-center justify-center">Loading accounts…</div>;

  return (
    <div className="p-4 md:p-8 max-w-5xl mx-auto text-text-primary pb-24 relative">
      <div className="flex flex-row items-center mb-8 gap-4">
        <button onClick={() => navigate('/profile')} className="w-10 h-10 rounded-full bg-surface-elevated border border-border-subtle flex items-center justify-center hover:text-brand-primary transition-colors" aria-label="Back to profile"><span className="material-symbols-outlined">arrow_back</span></button>
        <div><h1 className="text-2xl md:text-3xl font-semibold tracking-tight mb-1 text-white">Accounts</h1><p className="text-sm text-text-secondary hidden md:block">Roqqu account reads are read-only and refreshed on demand.</p></div>
      </div>

      {error && <div role="alert" className="glass-card border border-adherence-broken/30 p-4 mb-4 text-sm text-adherence-broken">{error}</div>}
      {notice && <div role="status" className="glass-card border border-brand-primary/30 p-4 mb-4 text-sm text-text-primary">{notice}</div>}

      {hasAccountAccess ? (
        <div className="glass-card p-6">
          <div className="flex flex-col sm:flex-row sm:justify-between sm:items-start gap-4 mb-6">
            <div className="flex items-center gap-4">
              <div className="w-12 h-12 rounded-xl bg-surface-elevated border border-border-subtle flex items-center justify-center"><span className="material-symbols-outlined text-brand-primary text-2xl">bolt</span></div>
              <div>
                <h2 className="text-lg font-semibold text-white">{isSample ? 'Roqqu sample account' : 'Roqqu wallets'}</h2>
                <div className="flex flex-wrap items-center gap-2 mt-1">
                  <span className={`w-2 h-2 rounded-full ${isSample ? 'bg-adherence-indeterminate' : 'bg-adherence-followed'}`} />
                  <span className={`text-xs font-medium ${isSample ? 'text-adherence-indeterminate' : 'text-adherence-followed'}`}>{isSample ? 'Sample data' : 'Connected · read-only'}</span>
                  {status?.mode && <span className="text-[10px] uppercase tracking-wider text-text-tertiary">{status.mode}</span>}
                </div>
                {identity?.email && <p className="text-xs text-text-tertiary mt-1">Verified identity: {identity.email}</p>}
              </div>
            </div>
            <div className="flex gap-2">
              {!isSample && isLiveConnected && <button onClick={handleDisconnect} disabled={busy} className="px-3 py-2 rounded-lg border border-border-subtle text-xs text-text-secondary hover:text-adherence-broken hover:border-adherence-broken/40 disabled:opacity-50">Disconnect</button>}
              <button onClick={handleRefresh} disabled={busy} className="px-4 py-2 rounded-lg bg-brand-primary text-white text-xs font-semibold hover:bg-blue-600 disabled:opacity-50 flex items-center gap-2"><span className={`material-symbols-outlined text-[16px] ${busy ? 'animate-spin' : ''}`}>{busy ? 'progress_activity' : 'refresh'}</span>{busy ? 'Working…' : isSample ? 'Refresh sample data' : 'Refresh wallet list'}</button>
            </div>
          </div>

          {isSample ? (
            <>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4 pt-4 border-t border-border-subtle">
                {balanceRows.length ? balanceRows.map(([asset, amount]) => <div key={asset} className="bg-[#0B0F19]/40 rounded-xl p-4 border border-border-subtle/50"><p className="text-[10px] text-text-tertiary uppercase tracking-wider mb-1">{asset}</p><p className="text-lg font-semibold text-white tabular-nums">{Number(amount).toLocaleString(undefined, { maximumFractionDigits: 8 })}</p></div>) : <div className="md:col-span-3 text-sm text-text-secondary">Sample balances are ready. Choose <b>Refresh sample data</b> to load them.</div>}
              </div>
              {balances && <p className="text-[10px] text-text-tertiary mt-3">Sample snapshot: {dateLabel(balanceObject?.updated_at || balances.updated_at || balances.timestamp)}</p>}
              {history && <div className="mt-6 pt-5 border-t border-border-subtle">
                <div className="flex items-center justify-between mb-3"><h3 className="text-sm font-semibold text-white">Sample ledger activity</h3><span className="text-[10px] text-text-tertiary">Sample only · not trades</span></div>
                {historyRows.length === 0 ? <p className="text-sm text-text-secondary">No sample entries.</p> : <div className="overflow-x-auto"><table className="w-full text-left text-xs"><thead className="text-text-tertiary"><tr><th className="py-2 pr-4 font-medium">Asset</th><th className="py-2 pr-4 font-medium">Direction</th><th className="py-2 pr-4 font-medium">Amount</th><th className="py-2 font-medium">Date</th></tr></thead><tbody className="divide-y divide-border-subtle">{historyRows.map((row, index) => <tr key={row.id || `${row.token || 'row'}-${index}`} className="text-text-secondary"><td className="py-3 pr-4 uppercase">{row.token || row.asset || '—'}</td><td className="py-3 pr-4 capitalize">{row.direction || '—'}</td><td className="py-3 pr-4 tabular-nums">{row.amount ?? '—'}</td><td className="py-3">{dateLabel(row.created_at || row.timestamp)}</td></tr>)}</tbody></table></div>}
              </div>}
            </>
          ) : (
            <>
              <div className="mt-4 pt-4 border-t border-border-subtle"><p className="text-xs text-text-tertiary mb-3">Wallet list is live from Roqqu. “Total received” is historical inbound volume, not spendable/current balance.</p>
                {!wallets.length ? <p className="text-sm text-text-secondary">No wallet list loaded yet. Select <b>Refresh wallet list</b>.</p> : <div className="overflow-x-auto"><table className="w-full text-left text-xs"><thead className="text-text-tertiary"><tr><th className="py-2 pr-4 font-medium">Asset</th><th className="py-2 pr-4 font-medium">Address</th><th className="py-2 pr-4 font-medium">Total received</th><th className="py-2 pr-4 font-medium">Received (USDT)</th><th className="py-2 font-medium">Details</th></tr></thead><tbody className="divide-y divide-border-subtle">{wallets.map((wallet) => <tr key={`${wallet.token}:${wallet.address}`} className="text-text-secondary"><td className="py-3 pr-4 uppercase">{wallet.token}</td><td className="py-3 pr-4 font-mono" title={wallet.address}>{wallet.address.length > 24 ? `${wallet.address.slice(0, 10)}…${wallet.address.slice(-8)}` : wallet.address}</td><td className="py-3 pr-4 tabular-nums">{wallet.total_received}</td><td className="py-3 pr-4 tabular-nums">{wallet.total_received_usdt}</td><td className="py-3"><button onClick={() => handleWalletDetails(wallet)} disabled={busy} className="text-brand-primary hover:underline disabled:opacity-50">Load on-chain</button></td></tr>)}</tbody></table></div>}
              </div>
              {balances?.updated_at && <p className="text-[10px] text-text-tertiary mt-3">Wallet list updated: {dateLabel(balances.updated_at)}</p>}
              {history && <div className="mt-6 pt-5 border-t border-border-subtle"><div className="flex items-start justify-between gap-3 mb-3"><div><h3 className="text-sm font-semibold text-white">On-chain snapshot · {history.symbol || history.network || 'wallet'}</h3><p className="text-[10px] font-mono text-text-tertiary mt-1">{history.address}</p></div><div className="text-right"><p className="text-[10px] text-text-tertiary">Current on-chain balance</p><p className="text-lg font-semibold text-white">{history.balance ?? '—'} {history.symbol || ''}</p></div></div><p className="text-[10px] text-text-tertiary mb-3">Roqqu rate-limits this endpoint to one request every 100 seconds; repeated same-wallet requests use a recent cache.</p>{liveTransactions.length ? <div className="overflow-x-auto"><table className="w-full text-left text-xs"><thead className="text-text-tertiary"><tr><th className="py-2 pr-4 font-medium">Transaction</th><th className="py-2 pr-4 font-medium">Block</th><th className="py-2 font-medium">Details</th></tr></thead><tbody className="divide-y divide-border-subtle">{liveTransactions.slice(0, 20).map((tx, index) => <tr key={tx.txid || tx.hash || index} className="text-text-secondary"><td className="py-3 pr-4 font-mono">{tx.txid || tx.hash || tx.id || `Transaction ${index + 1}`}</td><td className="py-3 pr-4">{tx.block_height ?? tx.block ?? '—'}</td><td className="py-3">{tx.amount ?? tx.value ?? tx.confirmations ?? '—'}</td></tr>)}</tbody></table></div> : <p className="text-sm text-text-secondary">No on-chain transaction records returned for this address.</p>}</div>}
            </>
          )}
        </div>
      ) : (
        <div className="glass-card p-12 text-center flex flex-col items-center justify-center min-h-[360px]">
          <div className="w-20 h-20 rounded-full bg-surface-elevated border border-border-subtle flex items-center justify-center mb-6"><span className="material-symbols-outlined text-4xl text-text-tertiary">link_off</span></div>
          <h2 className="text-xl font-semibold mb-2 text-white">No Roqqu identity linked</h2>
          <p className="text-sm text-text-secondary max-w-md mx-auto mb-6">{status?.auth_required ? 'Sign in with a verified Miroir account before linking a live Roqqu identity. Demo access remains separate.' : status?.configured === false ? 'Roqqu credential encryption is not configured on the backend. Live connections are disabled until the hosting environment has its encryption key.' : 'Connect a verified Miroir account to a dedicated Roqqu demo account for on-demand, read-only wallet data.'}</p>
          {canConnect ? <button onClick={() => setShowModal(true)} className="px-8 py-3 rounded-xl bg-brand-primary text-white font-semibold shadow-lg shadow-brand-primary/25 hover:bg-blue-600 transition-all flex items-center gap-2"><span className="material-symbols-outlined text-[20px]">add_link</span>Connect Roqqu</button> : status?.auth_required ? <button onClick={() => navigate('/')} className="px-6 py-2.5 rounded-lg bg-brand-primary text-white font-semibold">Return to sign in</button> : null}
        </div>
      )}

      {showModal && <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm">
        <div className="w-full max-w-md glass-card p-6 shadow-2xl relative">
          <button onClick={() => { setShowModal(false); setApiKey(''); }} className="absolute top-4 right-4 text-text-tertiary hover:text-white" aria-label="Close"><span className="material-symbols-outlined">close</span></button>
          <div className="text-center mb-5 mt-2"><h2 className="text-xl font-semibold text-white mb-2">Connect a Roqqu account</h2><p className="text-sm text-text-secondary">Use a dedicated demo or empty account. Public docs do not describe an API sandbox. Miroir stores the key encrypted and only calls documented wallet-read endpoints.</p></div>
          <label className="block text-xs font-medium text-text-secondary mb-2" htmlFor="roqqu-api-key">Roqqu API secret</label>
          <input id="roqqu-api-key" type="password" autoComplete="off" spellCheck="false" value={apiKey} onChange={(event) => setApiKey(event.target.value)} placeholder="Paste your Roqqu API key" className="w-full mb-3 px-4 py-3 rounded-lg bg-[#0B0F19] border border-border-subtle text-white text-sm outline-none focus:border-brand-primary" />
          <div className="mb-4 p-3 rounded-lg bg-adherence-indeterminate/10 border border-adherence-indeterminate/30 text-xs text-text-secondary">Roqqu documents account API keys as unrestricted. Miroir’s server only implements wallet reads; it does not send, trade, withdraw, or change settings. Do not use a key for a funded account in this demo.</div>
          <button onClick={handleConnect} disabled={busy || !canConnect || !apiKey.trim()} className="w-full p-4 rounded-xl bg-[#0B0F19]/50 border border-brand-primary/50 hover:bg-surface-elevated transition-all flex items-center gap-4 disabled:opacity-50"><span className="w-12 h-12 rounded-full bg-surface-elevated flex items-center justify-center"><span className="material-symbols-outlined text-brand-primary">bolt</span></span><span className="text-left"><span className="block text-sm font-semibold text-white">Connect read-only wallet data</span><span className="block text-xs text-text-secondary">Key stays on the backend · encrypted at rest</span></span>{busy && <span className="material-symbols-outlined animate-spin ml-auto">progress_activity</span>}</button>
          <div className="grid grid-cols-3 gap-3 mt-3">{[['MetaTrader', 'account_balance'], ['Binance', 'currency_bitcoin'], ['WalletConnect', 'wallet']].map(([name, icon]) => <div key={name} aria-disabled="true" className="p-3 rounded-xl bg-[#0B0F19]/30 border border-border-subtle opacity-50 flex flex-col items-center gap-2"><span className="material-symbols-outlined text-text-tertiary">{icon}</span><span className="text-[10px] text-text-secondary text-center">{name}<br />Coming soon</span></div>)}</div>
        </div>
      </div>}
    </div>
  );
}
