


        function assistantData() {
            return {
                data: {},
                lastUpdate: '-',
                tab: 'active',
                logs: [],
                tradeHistory: [],
                running: false,
                botBusy: false,
                suppressSyncUntil: 0,
                init() {
                    this.refresh();
                    setInterval(() => this.refresh(), 1000);
                    setInterval(() => this.refreshLogs(), 2000);
                },
                async refresh() {
                    try {
                        const response = await fetch('/api/latest');
                        this.data = await response.json();
                        this.lastUpdate = new Date().toLocaleTimeString();
                        // Keep the Start/Stop button in sync with the server, but not while a
                        // click is in flight or just after one (the server's flag lags ~1s).
                        if (!this.botBusy && Date.now() > this.suppressSyncUntil && this.data.trading_state?.running != null) {
                            this.running = !!this.data.trading_state.running;
                        }

                        if (this.tab === 'history') {
                            const hRes = await fetch('/history');
                            const history = await hRes.json();
                            this.tradeHistory = history.reverse();
                        }
                    } catch (e) {
                        console.error("Refresh failed", e);
                    }
                },
                async startBot() {
                    if (this.botBusy) return;
                    this.botBusy = true; this.running = true;
                    this.suppressSyncUntil = Date.now() + 3000;
                    try { const r = await fetch('/api/start', { method: 'POST' }); this.running = !!(await r.json()).running; }
                    catch (e) { this.running = false; }
                    this.suppressSyncUntil = Date.now() + 3000; this.botBusy = false;
                },
                async stopBot() {
                    if (this.botBusy) return;
                    this.botBusy = true; this.running = false;
                    this.suppressSyncUntil = Date.now() + 3000;
                    try { const r = await fetch('/api/stop', { method: 'POST' }); this.running = !!(await r.json()).running; }
                    catch (e) { this.running = true; }
                    this.suppressSyncUntil = Date.now() + 3000; this.botBusy = false;
                },
                async refreshLogs() {
                    if (this.tab !== 'logs') return;
                    try {
                        const response = await fetch('/api/logs');
                        const logs = await response.json();
                        this.logs = logs.reverse();
                    } catch (e) {}
                },
                // Download the full console log as a .log file (fetched fresh, chronological).
                async downloadLogs() {
                    let lines = [];
                    try {
                        const res = await fetch('/api/logs');
                        lines = await res.json();
                    } catch (e) {
                        lines = (this.logs || []).slice().reverse();
                    }
                    if (!lines || !lines.length) return;
                    const blob = new Blob([lines.join('\r\n') + '\r\n'], { type: 'text/plain;charset=utf-8;' });
                    const url = URL.createObjectURL(blob);
                    const a = document.createElement('a');
                    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
                    a.href = url;
                    a.download = 'console-' + stamp + '.log';
                    document.body.appendChild(a);
                    a.click();
                    document.body.removeChild(a);
                    URL.revokeObjectURL(url);
                },
                // Export ALL closed trades to a CSV file (fetched fresh so it isn't
                // limited to what's currently rendered).
                async downloadHistoryCsv() {
                    let rows = this.tradeHistory;
                    try {
                        const res = await fetch('/history');
                        rows = await res.json();          // chronological order from the server
                    } catch (e) { /* fall back to what's loaded */ }
                    if (!rows || !rows.length) return;

                    const cols = [
                        'market_slug', 'market_id', 'side', 'opened_by', 'entry_price',
                        'amount_usd', 'shares', 'exit', 'market_won',
                        'open_price', 'close_price', 'profit_loss',
                        'strike_source', 'mode', 'entry_time', 'close_time'
                    ];
                    const esc = (v) => {
                        if (v === null || v === undefined) return '';
                        const s = String(v);
                        return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
                    };
                    const exitLabel = (t) => {
                        if (t.exit_reason === 'take_profit') return 'TP';
                        if (t.exit_reason === 'stop_loss') return 'SL';
                        if (t.exit_reason) return t.exit_reason.toUpperCase();
                        return t.status === 'VOID' ? 'VOID' : 'SETTLED';
                    };
                    const line = (t) => [
                        t.market_slug, t.market_id, t.side,
                        t.open_reason === 'flip_entry' ? 'FLIP' : 'EV',
                        t.entry_price, t.amount, t.shares,
                        exitLabel(t),
                        t.market_won == null ? '' : (t.market_won ? 'won' : 'lost'),
                        t.open_price, t.close_price, t.profit_loss,
                        t.strike_source, t.mode,
                        t.entry_time || '', t.exit_time || ''
                    ].map(esc).join(',');

                    const csv = [cols.join(','), ...rows.map(line)].join('\r\n');
                    const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8;' });
                    const url = URL.createObjectURL(blob);
                    const a = document.createElement('a');
                    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
                    a.href = url;
                    a.download = 'closed-trades-' + stamp + '.csv';
                    document.body.appendChild(a);
                    a.click();
                    document.body.removeChild(a);
                    URL.revokeObjectURL(url);
                },
                formatTime(mins) {
                    if (!mins && mins !== 0) return '--:--';
                    const totalSecs = Math.max(0, Math.floor(mins * 60));
                    const m = Math.floor(totalSecs / 60);
                    const s = totalSecs % 60;
                    return m.toString().padStart(2, '0') + ':' + s.toString().padStart(2, '0');
                }
            }
        }
    