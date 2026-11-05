import { randomUUID } from 'node:crypto';
import { createOpaqueToken, hashToken, normalizeEmail } from './security.js';
import { DEMO_STRATEGY } from './fixtures.js';
import { evaluateTrade, DIMENSION_ORDER } from './scoring.js';
import { buildTrendSeries } from './analytics.js';

const sampleDate = (days, hour = 10) => {
  const date = new Date(); date.setUTCDate(date.getUTCDate() - days); date.setUTCHours(hour, 0, 0, 0); return date.toISOString();
};
const mapTrade = (row) => ({ id: row.id, identity_id: row.identity_id, strategy_id: row.strategy_id, strategy_version_id: row.strategy_version_id, ...row.payload, created_at: row.created_at.toISOString() });

export class PostgresStore {
  constructor(pool, { sessionTtlHours = 24 } = {}) { this.pool = pool; this.sessionTtlHours = sessionTtlHours; }

  async createDemoSession(displayName = 'Demo Trader') {
    const identityId = randomUUID(); const token = createOpaqueToken(); const strategy = { ...structuredClone(DEMO_STRATEGY), id: randomUUID(), current_version_id: randomUUID() };
    const expiresAt = new Date(Date.now() + this.sessionTtlHours * 3600_000).toISOString();
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('INSERT INTO identities(id, mode, display_name) VALUES($1, $2, $3)', [identityId, 'demo', displayName]);
      await client.query('INSERT INTO sessions(token_hash, identity_id, expires_at) VALUES($1, $2, $3)', [hashToken(token), identityId, expiresAt]);
      await client.query('INSERT INTO strategies(id, identity_id, name, rules, trading_schedule, current_version_id) VALUES($1, $2, $3, $4, $5, $6)', [strategy.id, identityId, strategy.name, JSON.stringify(strategy.draft_rules), JSON.stringify(strategy.draft_trading_schedule), strategy.current_version_id]);
      for (const payload of this.samplePayloads()) {
        const tradeId = randomUUID();
        const trade = { id: tradeId, identity_id: identityId, strategy_id: strategy.id, strategy_version_id: strategy.current_version_id, ...payload };
        await client.query('INSERT INTO trades(id, identity_id, strategy_id, strategy_version_id, payload, created_at) VALUES($1, $2, $3, $4, $5, $6)', [tradeId, identityId, strategy.id, strategy.current_version_id, JSON.stringify(payload), payload.opened_at]);
        const result = evaluateTrade(trade, strategy);
        await client.query('INSERT INTO reviews(id, trade_id, result, created_at) VALUES($1, $2, $3, $4)', [randomUUID(), tradeId, JSON.stringify(result), payload.closed_at]);
      }
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
    return { token, token_type: 'Bearer', expires_at: expiresAt, identity: { id: identityId, mode: 'demo', display_name: displayName }, demo_data: { strategy_id: strategy.id, strategy_version_id: strategy.current_version_id, trade_count: 3, review_count: 3 } };
  }

  samplePayloads() {
    return [
      { symbol: 'BTC/USDT', direction: 'long', quantity: 0.5, entry_price: 63000, exit_price: 65000, realized_pnl: 1000, risk_amount: 80, opened_at: sampleDate(2, 10), closed_at: sampleDate(2, 14), evidence: [{ kind: 'note', payload: { setup_note: 'Breakout above weekly resistance with volume confirmation.' } }, { kind: 'state', payload: { emotional_state: 'calm' } }] },
      { symbol: 'ETH/USDT', direction: 'short', quantity: 2, entry_price: 3500, exit_price: 3550, realized_pnl: -100, risk_amount: 120, opened_at: sampleDate(1, 11), closed_at: sampleDate(1, 12), evidence: [{ kind: 'note', payload: { setup_note: 'Failed retest at the range high.' } }, { kind: 'state', payload: { emotional_state: 'anxious' } }] },
      { symbol: 'SOL/USDT', direction: 'long', quantity: 10, entry_price: 150, exit_price: 154.5, realized_pnl: 45, risk_amount: 60, opened_at: sampleDate(3, 9), closed_at: sampleDate(3, 11), evidence: [{ kind: 'note', payload: { setup_note: 'Higher-low continuation setup.' } }, { kind: 'state', payload: { emotional_state: 'calm' } }] }
    ];
  }

  async authenticate(token) {
    const { rows } = await this.pool.query('SELECT i.id,i.mode,i.display_name,u.email,u.email_verified_at FROM sessions s JOIN identities i ON i.id=s.identity_id LEFT JOIN users u ON u.id=i.user_id WHERE s.token_hash=$1 AND s.expires_at > now()', [hashToken(token)]);
    if (!rows[0]) return null;
    return { ...rows[0], email_verified_at: rows[0].email_verified_at?.toISOString() || null };
  }

  async ensureNeonIdentity({ subject, email, emailVerified, name }) {
    if (typeof subject !== 'string' || !subject || typeof email !== 'string' || !email) throw new Error('Neon identity is missing a subject or email.');
    const normalizedEmail = normalizeEmail(email);
    const displayName = typeof name === 'string' && name.trim() ? name.trim().slice(0, 80) : 'Miroir Trader';
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`neon-user:${subject}`]);
      let result = await client.query('SELECT id, email, auth_subject FROM users WHERE auth_subject=$1 FOR UPDATE', [subject]);
      if (!result.rows[0]) {
        result = await client.query('SELECT id, email, auth_subject FROM users WHERE lower(email)=lower($1) FOR UPDATE', [normalizedEmail]);
        if (result.rows[0]?.auth_subject && result.rows[0].auth_subject !== subject) throw new Error('This email is already linked to a different Neon identity.');
      }

      let userId = result.rows[0]?.id;
      if (userId) {
        await client.query(
          'UPDATE users SET email=$2, auth_subject=$1, email_verified_at=CASE WHEN $3 THEN COALESCE(email_verified_at, now()) ELSE NULL END WHERE id=$4',
          [subject, normalizedEmail, emailVerified === true, userId]
        );
      } else {
        userId = randomUUID();
        await client.query(
          'INSERT INTO users(id,email,password_hash,email_verified_at,auth_subject) VALUES($1,$2,NULL,CASE WHEN $3 THEN now() ELSE NULL END,$4)',
          [userId, normalizedEmail, emailVerified === true, subject]
        );
      }

      let identityResult = await client.query('SELECT id,mode,display_name FROM identities WHERE user_id=$1 FOR UPDATE', [userId]);
      let identity = identityResult.rows[0];
      if (!identity) {
        const identityId = randomUUID();
        const strategy = { ...structuredClone(DEMO_STRATEGY), id: randomUUID(), name: 'Starter Strategy', current_version_id: randomUUID() };
        await client.query('INSERT INTO identities(id,mode,user_id,display_name) VALUES($1,\'user\',$2,$3)', [identityId, userId, displayName]);
        await client.query('INSERT INTO strategies(id,identity_id,name,rules,trading_schedule,current_version_id) VALUES($1,$2,$3,$4,$5,$6)', [strategy.id, identityId, strategy.name, JSON.stringify(strategy.draft_rules), JSON.stringify(strategy.draft_trading_schedule), strategy.current_version_id]);
        identity = { id: identityId, mode: 'user', display_name: displayName };
      } else if (identity.mode !== 'user') {
        throw new Error('Neon identity is linked to an invalid Miroir identity.');
      }

      const { rows } = await client.query('SELECT email_verified_at FROM users WHERE id=$1', [userId]);
      await client.query('COMMIT');
      return { id: identity.id, mode: 'user', display_name: identity.display_name, email: normalizedEmail, email_verified_at: rows[0]?.email_verified_at?.toISOString() || null };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally { client.release(); }
  }

  async revokeSession(token) { await this.pool.query('DELETE FROM sessions WHERE token_hash=$1', [hashToken(token)]); }

  async connectRoqqu(identityId, apiKeyCiphertext) {
    const { rows } = await this.pool.query("INSERT INTO roqqu_connections(identity_id,account_email,provider,api_key_ciphertext) SELECT i.id,u.email,'roqqu_api',$2 FROM identities i JOIN users u ON u.id=i.user_id WHERE i.id=$1 AND i.mode='user' AND u.email_verified_at IS NOT NULL ON CONFLICT(identity_id) DO UPDATE SET account_email=EXCLUDED.account_email,provider='roqqu_api',api_key_ciphertext=EXCLUDED.api_key_ciphertext,connected_at=now() RETURNING identity_id,account_email,connected_at,provider,api_key_ciphertext", [identityId, apiKeyCiphertext]);
    return rows[0] ? { ...rows[0], connected_at: rows[0].connected_at.toISOString() } : null;
  }

  async getRoqquConnection(identityId) {
    const { rows } = await this.pool.query('SELECT identity_id,account_email,connected_at,provider,api_key_ciphertext FROM roqqu_connections WHERE identity_id=$1', [identityId]);
    return rows[0] ? { ...rows[0], connected_at: rows[0].connected_at.toISOString() } : null;
  }

  async getRoqquAddressCache(symbol, address, maxAgeMs = 100_000) {
    const { rows } = await this.pool.query('SELECT data,fetched_at FROM roqqu_address_cache WHERE symbol=$1 AND address=$2', [symbol, address]);
    if (!rows[0] || Date.now() - rows[0].fetched_at.getTime() >= maxAgeMs) return null;
    return { data: rows[0].data, fetched_at: rows[0].fetched_at.toISOString() };
  }

  async reserveRoqquAddressLookup(minIntervalMs = 100_000) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT pg_advisory_xact_lock(hashtext('miroir:roqqu:blockchain-address'))");
      const { rows } = await client.query("SELECT last_requested_at FROM roqqu_api_rate_limit WHERE endpoint='blockchain_address' FOR UPDATE");
      if (rows[0]) {
        const retryAfterMs = minIntervalMs - (Date.now() - rows[0].last_requested_at.getTime());
        if (retryAfterMs > 0) {
          await client.query('COMMIT');
          return { allowed: false, retry_after_seconds: Math.ceil(retryAfterMs / 1000) };
        }
      }
      await client.query("INSERT INTO roqqu_api_rate_limit(endpoint,last_requested_at) VALUES('blockchain_address',now()) ON CONFLICT(endpoint) DO UPDATE SET last_requested_at=EXCLUDED.last_requested_at");
      await client.query('COMMIT');
      return { allowed: true, retry_after_seconds: 0 };
    } catch (error) {
      await client.query('ROLLBACK'); throw error;
    } finally { client.release(); }
  }

  async saveRoqquAddressCache(symbol, address, data) {
    const { rows } = await this.pool.query('INSERT INTO roqqu_address_cache(symbol,address,data,fetched_at) VALUES($1,$2,$3,now()) ON CONFLICT(symbol,address) DO UPDATE SET data=EXCLUDED.data,fetched_at=EXCLUDED.fetched_at RETURNING fetched_at', [symbol, address, JSON.stringify(data)]);
    return rows[0]?.fetched_at?.toISOString() || new Date().toISOString();
  }

  async disconnectRoqqu(identityId) { await this.pool.query('DELETE FROM roqqu_connections WHERE identity_id=$1', [identityId]); }
  async getStrategies(identityId) {
    const { rows } = await this.pool.query('SELECT id,name,rules,trading_schedule,current_version_id FROM strategies WHERE identity_id=$1 ORDER BY created_at', [identityId]);
    return { strategies: rows.map((row) => ({ id: row.id, name: row.name, draft_rules: row.rules, draft_trading_schedule: row.trading_schedule, current_version_id: row.current_version_id })) };
  }
  async createTrade(identityId, payload) {
    const strategy = (await this.getStrategies(identityId)).strategies[0]; if (!strategy) throw new Error('STRATEGY_NOT_FOUND');
    const id = randomUUID(); const strategyVersionId = payload.strategy_version_id || strategy.current_version_id;
    const cleanPayload = { ...payload }; delete cleanPayload.strategy_version_id;
    const { rows } = await this.pool.query('INSERT INTO trades(id,identity_id,strategy_id,strategy_version_id,payload) VALUES($1,$2,$3,$4,$5) RETURNING created_at', [id, identityId, strategy.id, strategyVersionId, JSON.stringify(cleanPayload)]);
    return { id, identity_id: identityId, strategy_id: strategy.id, strategy_version_id: strategyVersionId, ...cleanPayload, created_at: rows[0].created_at.toISOString() };
  }
  async listTrades(identityId) {
    const { rows } = await this.pool.query('SELECT t.*, r.id AS review_id, r.result AS review_result FROM trades t LEFT JOIN reviews r ON r.trade_id=t.id WHERE t.identity_id=$1 ORDER BY t.created_at DESC', [identityId]);
    const trades = rows.map((row) => ({ ...mapTrade(row), review: row.review_id ? { id: row.review_id, result: row.review_result } : null }));
    return { trades, total: trades.length };
  }
  async getTrade(identityId, tradeId) {
    const { rows } = await this.pool.query('SELECT * FROM trades WHERE id=$1 AND identity_id=$2', [tradeId, identityId]);
    return rows[0] ? mapTrade(rows[0]) : null;
  }
  async getReview(identityId, tradeId) {
    const { rows } = await this.pool.query('SELECT r.* FROM reviews r JOIN trades t ON t.id=r.trade_id WHERE t.id=$1 AND t.identity_id=$2', [tradeId, identityId]);
    return rows[0] ? { id: rows[0].id, trade_id: tradeId, result: rows[0].result, created_at: rows[0].created_at.toISOString() } : null;
  }
  async saveReview(identityId, tradeId, result) {
    const { rows } = await this.pool.query('INSERT INTO reviews(id,trade_id,result) SELECT $1,$2,$3 WHERE EXISTS (SELECT 1 FROM trades WHERE id=$2 AND identity_id=$4) ON CONFLICT(trade_id) DO UPDATE SET result=EXCLUDED.result RETURNING id,trade_id,result,created_at', [randomUUID(), tradeId, JSON.stringify(result), identityId]);
    return rows[0] ? { id: rows[0].id, trade_id: rows[0].trade_id, result: rows[0].result, created_at: rows[0].created_at.toISOString() } : null;
  }
  async getStats(identityId, currency = 'USD') {
    const { rows } = await this.pool.query('SELECT id,payload,created_at FROM trades WHERE identity_id=$1 ORDER BY created_at', [identityId]);
    const closed = rows.map((row) => ({ id: row.id, ...row.payload })).filter((trade) => trade.closed_at && Number.isFinite(Number(trade.realized_pnl)));
    const values = closed.map((trade) => Number(trade.realized_pnl));
    if (!values.length) return { currency, sample_size: 0, wins: 0, losses: 0, win_rate: null, net_realized_pnl: 0, profit_factor: null, expectancy: null, cumulative_realized_pnl_curve: [] };
    const wins = values.filter((value) => value > 0).length; const losses = values.filter((value) => value < 0).length;
    const positive = values.filter((value) => value > 0).reduce((sum, value) => sum + value, 0); const negative = Math.abs(values.filter((value) => value < 0).reduce((sum, value) => sum + value, 0));
    let cumulative = 0;
    const curve = closed.sort((a, b) => new Date(a.closed_at) - new Date(b.closed_at)).map((trade) => ({ trade_id: trade.id, closed_at: trade.closed_at, cumulative_realized_pnl: (cumulative += Number(trade.realized_pnl)) }));
    return { currency, sample_size: values.length, wins, losses, win_rate: wins / values.length * 100, net_realized_pnl: values.reduce((sum, value) => sum + value, 0), profit_factor: negative ? positive / negative : null, expectancy: values.reduce((sum, value) => sum + value, 0) / values.length, cumulative_realized_pnl_curve: curve };
  }
  async getProgress(identityId) {
    const { rows } = await this.pool.query('SELECT t.id AS trade_id,t.strategy_version_id,t.payload,t.created_at AS trade_created_at,r.id AS review_id,r.result,r.created_at AS review_created_at FROM trades t JOIN reviews r ON r.trade_id=t.id WHERE t.identity_id=$1', [identityId]);
    const groups = new Map();
    for (const row of rows) {
      const group = groups.get(row.strategy_version_id) || { results: [], trades: [], reviews: [] };
      group.results.push(row.result);
      group.trades.push({ id: row.trade_id, ...row.payload, created_at: row.trade_created_at.toISOString() });
      group.reviews.push({ id: row.review_id, trade_id: row.trade_id, result: row.result, created_at: row.review_created_at.toISOString() });
      groups.set(row.strategy_version_id, group);
    }
    const versions = [...groups].map(([versionId, group]) => {
      const { results } = group;
      const scores = results.map((result) => result.decision_quality_score).filter((score) => score !== null); const coverage = results.map((result) => result.coverage_pct);
      const counts = Object.fromEntries(DIMENSION_ORDER.map((dimension) => [dimension, { followed: 0, broken: 0, cannot_assess: 0 }]));
      for (const result of results) for (const dimension of result.dimensions) counts[dimension.dimension][dimension.status] += 1;
      return { strategy_version_id: versionId, assessed_trades: results.length, average_decision_quality_score: scores.length ? scores.reduce((sum, value) => sum + value, 0) / scores.length : null, average_coverage_pct: coverage.reduce((sum, value) => sum + value, 0) / coverage.length, trend: { eligible: results.length >= 5, series: results.length >= 5 ? buildTrendSeries(group.trades, group.reviews) : [] }, dimension_counts: counts };
    });
    return { progress: { versions } };
  }
}
